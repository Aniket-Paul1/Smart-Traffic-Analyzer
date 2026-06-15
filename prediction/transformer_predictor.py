"""
prediction/transformer_predictor.py

Informer-style Transformer for Long-Horizon Traffic Prediction
==============================================================
A lightweight ProbSparse self-attention transformer that predicts
traffic density N steps ahead.

Architecture
------------
- Input projection: (F features) → d_model
- ProbSparse multi-head self-attention encoder
- Decoder with cross-attention to encoder output
- Output projection: → (out_steps × num_lanes)

Usage
-----
    model = TrafficTransformer(num_lanes=4, in_features=4, out_steps=12)
    x = torch.randn(8, 16, 4, 4)   # (B, T_in, N, F)
    pred = model(x)                  # (8, 12, 4)
"""

from __future__ import annotations

import math
import os
import glob
from typing import Optional, List

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader, Dataset


# ---------------------------------------------------------------------------
# Positional Encoding
# ---------------------------------------------------------------------------

class PositionalEncoding(nn.Module):
    def __init__(self, d_model: int, max_len: int = 512, dropout: float = 0.1) -> None:
        super().__init__()
        self.drop = nn.Dropout(dropout)
        pe = torch.zeros(max_len, d_model)
        pos = torch.arange(0, max_len).float().unsqueeze(1)
        div = torch.exp(torch.arange(0, d_model, 2).float() * (-math.log(10000.0) / d_model))
        pe[:, 0::2] = torch.sin(pos * div)
        pe[:, 1::2] = torch.cos(pos * div[:d_model // 2])
        self.register_buffer("pe", pe.unsqueeze(0))   # (1, max_len, d_model)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.drop(x + self.pe[:, :x.size(1)])


# ---------------------------------------------------------------------------
# ProbSparse attention (simplified: top-k selection on queries)
# ---------------------------------------------------------------------------

class ProbSparseAttention(nn.Module):
    def __init__(self, d_model: int, n_heads: int, top_k_factor: float = 0.25) -> None:
        super().__init__()
        assert d_model % n_heads == 0
        self.h = n_heads
        self.dk = d_model // n_heads
        self.top_k_factor = top_k_factor
        self.q_proj = nn.Linear(d_model, d_model)
        self.k_proj = nn.Linear(d_model, d_model)
        self.v_proj = nn.Linear(d_model, d_model)
        self.out_proj = nn.Linear(d_model, d_model)

    def forward(
        self,
        q: torch.Tensor,
        k: torch.Tensor,
        v: torch.Tensor,
        mask: Optional[torch.Tensor] = None,
    ) -> torch.Tensor:
        B, Lq, _ = q.shape
        Lk = k.size(1)

        Q = self._split_heads(self.q_proj(q))   # (B, h, Lq, dk)
        K = self._split_heads(self.k_proj(k))
        V = self._split_heads(self.v_proj(v))

        # Select top-U queries by approximate maximum Q·K score
        U = max(1, int(self.top_k_factor * math.log(max(Lq, 1)) * Lk))
        U = min(U, Lq)

        # Sample a random subset of keys to estimate score
        sample_k = min(Lk, max(1, int(math.sqrt(Lk))))
        idx = torch.randint(0, Lk, (sample_k,), device=q.device)
        K_sample = K[:, :, idx, :]   # (B, h, sample_k, dk)
        scores_sample = torch.einsum("bhid,bhjd->bhij", Q, K_sample) / math.sqrt(self.dk)
        M = scores_sample.max(dim=-1).values - scores_sample.mean(dim=-1)  # (B, h, Lq)
        top_idx = M.topk(U, dim=-1).indices  # (B, h, U)

        # Gather top-U queries
        Q_sparse = torch.gather(
            Q,
            2,
            top_idx.unsqueeze(-1).expand(-1, -1, -1, self.dk),
        )  # (B, h, U, dk)

        attn_scores = torch.einsum("bhud,bhkd->bhuk", Q_sparse, K) / math.sqrt(self.dk)
        if mask is not None:
            attn_scores = attn_scores.masked_fill(mask[:, :, :U, :Lk], float("-inf"))
        attn_w = torch.softmax(attn_scores, dim=-1)
        ctx_sparse = torch.einsum("bhuk,bhkd->bhud", attn_w, V)  # (B, h, U, dk)

        # Fill output tensor (non-selected positions get mean of V)
        ctx = V.mean(dim=2, keepdim=True).expand(-1, -1, Lq, -1).clone()
        ctx.scatter_(
            2,
            top_idx.unsqueeze(-1).expand(-1, -1, -1, self.dk),
            ctx_sparse,
        )

        ctx = ctx.transpose(1, 2).contiguous().view(B, Lq, -1)
        return self.out_proj(ctx)

    def _split_heads(self, x: torch.Tensor) -> torch.Tensor:
        B, L, D = x.shape
        return x.view(B, L, self.h, self.dk).transpose(1, 2)


# ---------------------------------------------------------------------------
# Encoder / Decoder blocks
# ---------------------------------------------------------------------------

class EncoderBlock(nn.Module):
    def __init__(self, d_model: int, n_heads: int, ff_dim: int, dropout: float = 0.1) -> None:
        super().__init__()
        self.attn = ProbSparseAttention(d_model, n_heads)
        self.ff = nn.Sequential(
            nn.Linear(d_model, ff_dim),
            nn.GELU(),
            nn.Linear(ff_dim, d_model),
        )
        self.norm1 = nn.LayerNorm(d_model)
        self.norm2 = nn.LayerNorm(d_model)
        self.drop = nn.Dropout(dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.norm1(x + self.drop(self.attn(x, x, x)))
        x = self.norm2(x + self.drop(self.ff(x)))
        return x


# ---------------------------------------------------------------------------
# Full Traffic Transformer
# ---------------------------------------------------------------------------

class TrafficTransformer(nn.Module):
    """
    Parameters
    ----------
    num_lanes : int
    in_features : int   per-lane features (density, speed, cong, width)
    d_model : int       internal model dimension
    n_heads : int       attention heads
    n_layers : int      encoder layers
    ff_dim : int        feedforward hidden size
    out_steps : int     prediction horizon
    dropout : float
    """

    def __init__(
        self,
        num_lanes: int = 4,
        in_features: int = 4,
        d_model: int = 64,
        n_heads: int = 4,
        n_layers: int = 2,
        ff_dim: int = 128,
        out_steps: int = 6,
        dropout: float = 0.1,
    ) -> None:
        super().__init__()
        self.num_lanes = num_lanes
        self.out_steps = out_steps

        # Flatten (N, F) → (N*F) then project to d_model per timestep
        self.input_proj = nn.Linear(num_lanes * in_features, d_model)
        self.pos_enc = PositionalEncoding(d_model, dropout=dropout)

        self.encoder = nn.ModuleList([
            EncoderBlock(d_model, n_heads, ff_dim, dropout)
            for _ in range(n_layers)
        ])

        # Predict out_steps × num_lanes from last encoder state
        self.head = nn.Sequential(
            nn.Linear(d_model, ff_dim),
            nn.GELU(),
            nn.Linear(ff_dim, out_steps * num_lanes),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """
        x : (B, T_in, N, F)
        Returns (B, out_steps, N)
        """
        B, T, N, F = x.shape
        x_flat = x.view(B, T, N * F)            # (B, T, N*F)
        h = self.input_proj(x_flat)              # (B, T, d_model)
        h = self.pos_enc(h)

        for block in self.encoder:
            h = block(h)

        last = h[:, -1, :]                       # (B, d_model)
        out = self.head(last)                    # (B, out_steps * N)
        return out.view(B, self.out_steps, N)    # (B, out_steps, N)


# ---------------------------------------------------------------------------
# Dataset  (reuse same CSV format)
# ---------------------------------------------------------------------------

class TransformerDataset(Dataset):
    def __init__(
        self,
        csv_dir: str = "logs",
        t_in: int = 16,
        t_out: int = 6,
        lane_widths: Optional[List[float]] = None,
        vehicles_per_m_width: float = 2.5,
    ) -> None:
        self.samples = []
        self.num_nodes = 0
        files = sorted(glob.glob(os.path.join(csv_dir, "*_timeseries.csv")))

        for fp in files:
            try:
                df = pd.read_csv(fp)
            except Exception:
                continue

            density_cols = sorted(
                [c for c in df.columns if c.startswith("density_lane_")],
                key=lambda s: int(s.split("_")[-1]),
            )
            speed_cols = sorted(
                [c for c in df.columns if c.startswith("avg_speed_lane_")],
                key=lambda s: int(s.split("_")[-1]),
            )
            if not density_cols:
                continue
            N = len(density_cols)
            self.num_nodes = max(self.num_nodes, N)

            widths = lane_widths if lane_widths and len(lane_widths) >= N else [3.5] * N
            capacities = [max(1.0, w * vehicles_per_m_width) for w in widths[:N]]

            dens = df[density_cols].values.astype(np.float32)
            spd = df[speed_cols[:N]].values.astype(np.float32) if len(speed_cols) >= N else np.zeros_like(dens)

            max_d = max(1.0, float(dens.max()))
            dens_n = dens / max_d
            spd_n = np.clip(spd / 100.0, 0.0, 1.0)
            cong = np.stack([np.clip(dens[:, i] / capacities[i], 0.0, 1.0) for i in range(N)], axis=1)
            wf = np.tile([[w / 10.0 for w in widths[:N]]], (len(df), 1))
            feat = np.stack([dens_n, spd_n, cong, wf], axis=-1)  # (T, N, 4)

            T = len(feat)
            for i in range(T - t_in - t_out + 1):
                x = feat[i: i + t_in]
                y = dens_n[i + t_in: i + t_in + t_out]
                self.samples.append((x.astype(np.float32), y.astype(np.float32)))

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, idx: int):
        x, y = self.samples[idx]
        return torch.from_numpy(x), torch.from_numpy(y)


# ---------------------------------------------------------------------------
# Trainer
# ---------------------------------------------------------------------------

class TransformerTrainer:
    def __init__(
        self,
        csv_dir: str = "logs",
        t_in: int = 16,
        t_out: int = 6,
        d_model: int = 64,
        n_heads: int = 4,
        n_layers: int = 2,
        lr: float = 1e-3,
        batch_size: int = 32,
        device: str = "cpu",
        save_path: str = "transformer_predictor.pth",
        lane_widths: Optional[List[float]] = None,
    ) -> None:
        self.csv_dir = csv_dir
        self.t_in = t_in
        self.t_out = t_out
        self.d_model = d_model
        self.n_heads = n_heads
        self.n_layers = n_layers
        self.lr = lr
        self.batch_size = batch_size
        self.device = torch.device(device)
        self.save_path = save_path
        self.lane_widths = lane_widths
        self.model: Optional[TrafficTransformer] = None

    def train(self, epochs: int = 50) -> None:
        ds = TransformerDataset(self.csv_dir, self.t_in, self.t_out, self.lane_widths)
        if len(ds) == 0:
            raise RuntimeError(f"No samples in {self.csv_dir}")

        N = ds.num_nodes
        self.model = TrafficTransformer(
            num_lanes=N, in_features=4, d_model=self.d_model,
            n_heads=self.n_heads, n_layers=self.n_layers, out_steps=self.t_out,
        ).to(self.device)

        loader = DataLoader(ds, batch_size=self.batch_size, shuffle=True, drop_last=False)
        opt = optim.Adam(self.model.parameters(), lr=self.lr)
        loss_fn = nn.MSELoss()

        print(f"[TransformerTrainer] nodes={N} samples={len(ds)} device={self.device}")
        for epoch in range(1, epochs + 1):
            self.model.train()
            total = 0.0
            for xb, yb in loader:
                xb, yb = xb.to(self.device), yb.to(self.device)
                pred = self.model(xb)
                loss = loss_fn(pred, yb)
                opt.zero_grad(); loss.backward(); opt.step()
                total += loss.item()
            if epoch % 10 == 0 or epoch == 1:
                print(f"  Epoch {epoch}/{epochs}  loss={total/len(loader):.6f}")

        torch.save(self.model.state_dict(), self.save_path)
        print(f"[TransformerTrainer] Saved → {self.save_path}")

    def predict(self, x: np.ndarray) -> np.ndarray:
        """x: (T_in, N, 4) → (T_out, N)"""
        if self.model is None:
            raise RuntimeError("Model not trained or loaded.")
        self.model.eval()
        t = torch.from_numpy(x).float().unsqueeze(0).to(self.device)
        with torch.no_grad():
            out = self.model(t)
        return out.squeeze(0).cpu().numpy()


if __name__ == "__main__":
    trainer = TransformerTrainer(csv_dir="logs")
    trainer.train(epochs=50)
