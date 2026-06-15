"""
prediction/gnn_predictor.py

Spatio-Temporal GNN Traffic Flow Predictor (AGCRN-inspired)
============================================================
Architecture
------------
- Node features: per-lane [vehicleCount, speed, congestionNorm, laneWidthM]
- Edge features: physical adjacency + inverse distance
- AGCRN: Adaptive Graph Convolutional Recurrent Network
  - Learnable node embedding → adaptive adjacency matrix
  - Graph Chebyshev convolution inside a GRU cell
- Output: next-T-step density prediction per lane

This module is self-contained (PyTorch only, no PyG required for core logic)
but integrates with PyG if installed.

Usage
-----
    predictor = AGCRNPredictor(num_nodes=4, in_features=4, hidden=32, out_steps=3)
    # x shape: (batch, time_steps, num_nodes, in_features)
    pred = predictor(x)   # (batch, out_steps, num_nodes)

    trainer = GNNTrainerFromCSV("logs/", predictor)
    trainer.train(epochs=50)
"""

from __future__ import annotations

import glob
import os
from typing import List, Optional, Tuple

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader, Dataset


# ---------------------------------------------------------------------------
# Adaptive adjacency matrix module
# ---------------------------------------------------------------------------

class AdaptiveAdjacency(nn.Module):
    """
    Learnable node embedding → soft adjacency matrix.
    A = softmax(ReLU(E · E^T))   where E is (N, d_emb).
    """

    def __init__(self, num_nodes: int, emb_dim: int = 10) -> None:
        super().__init__()
        self.emb = nn.Embedding(num_nodes, emb_dim)
        self.num_nodes = num_nodes

    def forward(self) -> torch.Tensor:
        e = self.emb.weight              # (N, d)
        a = torch.relu(e @ e.T)          # (N, N)
        a = torch.softmax(a, dim=-1)     # row-normalise
        return a


# ---------------------------------------------------------------------------
# Graph Chebyshev convolution (order-2 approximation)
# ---------------------------------------------------------------------------

class GraphConv(nn.Module):
    """
    Simplified graph convolution:  H' = σ(A H W)
    """

    def __init__(self, in_dim: int, out_dim: int) -> None:
        super().__init__()
        self.w = nn.Linear(in_dim, out_dim, bias=True)

    def forward(self, x: torch.Tensor, adj: torch.Tensor) -> torch.Tensor:
        # x: (B, N, in_dim)
        # adj: (N, N)
        h = torch.einsum("bni,nj->bji", x, adj)   # (B, N, in_dim)
        return torch.relu(self.w(h))               # (B, N, out_dim)


# ---------------------------------------------------------------------------
# AGCRN cell: GRU with adaptive graph convolution replacing the linear ops
# ---------------------------------------------------------------------------

class AGCRNCell(nn.Module):
    def __init__(self, num_nodes: int, in_dim: int, hidden: int) -> None:
        super().__init__()
        self.num_nodes = num_nodes
        self.hidden = hidden

        # Reset & update gates
        self.graph_r = GraphConv(in_dim + hidden, hidden)
        self.graph_u = GraphConv(in_dim + hidden, hidden)
        # Candidate hidden
        self.graph_c = GraphConv(in_dim + hidden, hidden)

    def forward(
        self,
        x: torch.Tensor,       # (B, N, in_dim)
        h: torch.Tensor,       # (B, N, hidden)
        adj: torch.Tensor,     # (N, N)
    ) -> torch.Tensor:
        xh = torch.cat([x, h], dim=-1)   # (B, N, in_dim+hidden)
        r = torch.sigmoid(self.graph_r(xh, adj))
        u = torch.sigmoid(self.graph_u(xh, adj))
        xrh = torch.cat([x, r * h], dim=-1)
        c = torch.tanh(self.graph_c(xrh, adj))
        h_next = (1 - u) * h + u * c
        return h_next


# ---------------------------------------------------------------------------
# Full AGCRN predictor
# ---------------------------------------------------------------------------

class AGCRNPredictor(nn.Module):
    """
    Adaptive Graph Convolutional Recurrent Network.

    Parameters
    ----------
    num_nodes : int   Number of lanes / intersections.
    in_features : int  Per-node per-timestep feature count.
    hidden : int      GRU hidden size.
    out_steps : int   Number of future steps to predict.
    emb_dim : int     Node embedding dimension for adaptive adjacency.
    """

    def __init__(
        self,
        num_nodes: int = 4,
        in_features: int = 4,
        hidden: int = 32,
        out_steps: int = 3,
        emb_dim: int = 10,
    ) -> None:
        super().__init__()
        self.num_nodes = num_nodes
        self.hidden = hidden
        self.out_steps = out_steps

        self.adj_module = AdaptiveAdjacency(num_nodes, emb_dim)
        self.encoder = AGCRNCell(num_nodes, in_features, hidden)
        # Decoder: one step at a time with zero input
        self.decoder = AGCRNCell(num_nodes, 1, hidden)
        self.out_proj = nn.Linear(hidden, 1)   # predict 1 value per node per step

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """
        Parameters
        ----------
        x : (B, T, N, F)  input sequence

        Returns
        -------
        (B, out_steps, N)  predicted densities
        """
        B, T, N, F = x.shape
        adj = self.adj_module()           # (N, N)
        h = torch.zeros(B, N, self.hidden, device=x.device)

        # Encode input sequence
        for t in range(T):
            h = self.encoder(x[:, t], h, adj)

        # Decode future steps
        preds = []
        dec_in = torch.zeros(B, N, 1, device=x.device)
        for _ in range(self.out_steps):
            h = self.decoder(dec_in, h, adj)
            out = self.out_proj(h)          # (B, N, 1)
            preds.append(out.squeeze(-1))   # (B, N)
            dec_in = out

        return torch.stack(preds, dim=1)   # (B, out_steps, N)


# ---------------------------------------------------------------------------
# Dataset: build from CSV timeseries logs
# ---------------------------------------------------------------------------

class TrafficGraphDataset(Dataset):
    """
    Loads lane CSV logs and creates (x, y) pairs for spatio-temporal prediction.

    x shape: (T_in, N, F)   where F = [density, speed, congestion_norm, lane_width_m]
    y shape: (T_out, N)     density targets
    """

    def __init__(
        self,
        csv_dir: str = "logs",
        t_in: int = 8,
        t_out: int = 3,
        lane_widths: Optional[List[float]] = None,
        vehicles_per_m_width: float = 2.5,
    ) -> None:
        self.t_in = t_in
        self.t_out = t_out
        files = sorted(glob.glob(os.path.join(csv_dir, "*_timeseries.csv")))
        self.samples: List[Tuple[np.ndarray, np.ndarray]] = []
        self.num_nodes = 0

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
            capacities = [max(1.0, w * vehicles_per_m_width) for w in widths]

            density = df[density_cols].values.astype(np.float32)  # (T, N)
            if speed_cols and len(speed_cols) >= N:
                speed = df[speed_cols[:N]].values.astype(np.float32)
            else:
                speed = np.zeros_like(density)

            # Normalize density per-file; keep speed in km/h / 100 for scale
            max_dens = max(1.0, float(density.max()))
            density_norm = density / max_dens
            speed_norm = np.clip(speed / 100.0, 0.0, 1.0)

            # Congestion norm per lane per timestep
            cong = np.stack([
                np.clip(density[:, i] / capacities[i], 0.0, 1.0)
                for i in range(N)
            ], axis=1)   # (T, N)

            # Lane width as static feature (repeated for all timesteps)
            width_feat = np.array([[w / 10.0 for w in widths[:N]]], dtype=np.float32)
            width_feat = np.repeat(width_feat, len(df), axis=0)   # (T, N)

            # Stack features: (T, N, 4)
            features = np.stack([density_norm, speed_norm, cong, width_feat], axis=-1)

            T = len(features)
            for i in range(T - t_in - t_out + 1):
                x = features[i: i + t_in]                            # (t_in, N, 4)
                y = density_norm[i + t_in: i + t_in + t_out]         # (t_out, N)
                self.samples.append((x, y))

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, idx: int):
        x, y = self.samples[idx]
        return torch.from_numpy(x), torch.from_numpy(y)


# ---------------------------------------------------------------------------
# Trainer
# ---------------------------------------------------------------------------

class GNNTrainer:
    """Train AGCRNPredictor from CSV logs."""

    def __init__(
        self,
        csv_dir: str = "logs",
        t_in: int = 8,
        t_out: int = 3,
        hidden: int = 32,
        lr: float = 1e-3,
        batch_size: int = 32,
        device: str = "cpu",
        save_path: str = "gnn_predictor.pth",
        lane_widths: Optional[List[float]] = None,
    ) -> None:
        self.csv_dir = csv_dir
        self.t_in = t_in
        self.t_out = t_out
        self.hidden = hidden
        self.lr = lr
        self.batch_size = batch_size
        self.device = torch.device(device)
        self.save_path = save_path
        self.lane_widths = lane_widths
        self.model: Optional[AGCRNPredictor] = None

    def train(self, epochs: int = 50) -> None:
        dataset = TrafficGraphDataset(
            csv_dir=self.csv_dir,
            t_in=self.t_in,
            t_out=self.t_out,
            lane_widths=self.lane_widths,
        )
        if len(dataset) == 0:
            raise RuntimeError(f"No training samples found in {self.csv_dir}")

        num_nodes = dataset.num_nodes
        self.model = AGCRNPredictor(
            num_nodes=num_nodes,
            in_features=4,
            hidden=self.hidden,
            out_steps=self.t_out,
        ).to(self.device)

        loader = DataLoader(dataset, batch_size=self.batch_size, shuffle=True, drop_last=False)
        optimizer = optim.Adam(self.model.parameters(), lr=self.lr)
        loss_fn = nn.MSELoss()

        print(f"[GNNTrainer] nodes={num_nodes} samples={len(dataset)} device={self.device}")
        for epoch in range(1, epochs + 1):
            self.model.train()
            total_loss = 0.0
            for x, y in loader:
                x, y = x.to(self.device), y.to(self.device)
                pred = self.model(x)          # (B, t_out, N)
                loss = loss_fn(pred, y)
                optimizer.zero_grad()
                loss.backward()
                optimizer.step()
                total_loss += loss.item()
            avg = total_loss / max(1, len(loader))
            if epoch % 10 == 0 or epoch == 1:
                print(f"  Epoch {epoch}/{epochs}  loss={avg:.6f}")

        torch.save(self.model.state_dict(), self.save_path)
        print(f"[GNNTrainer] Saved → {self.save_path}")

    def load(self, num_nodes: int, path: Optional[str] = None) -> AGCRNPredictor:
        p = path or self.save_path
        model = AGCRNPredictor(
            num_nodes=num_nodes,
            in_features=4,
            hidden=self.hidden,
            out_steps=self.t_out,
        )
        model.load_state_dict(torch.load(p, map_location="cpu"))
        model.eval()
        self.model = model
        return model

    def predict(self, x: np.ndarray) -> np.ndarray:
        """
        x : (T_in, N, 4) numpy array
        Returns (T_out, N) density predictions.
        """
        if self.model is None:
            raise RuntimeError("Model not trained or loaded.")
        self.model.eval()
        t = torch.from_numpy(x).float().unsqueeze(0).to(self.device)  # (1,T,N,F)
        with torch.no_grad():
            out = self.model(t)   # (1, t_out, N)
        return out.squeeze(0).cpu().numpy()   # (t_out, N)


if __name__ == "__main__":
    trainer = GNNTrainer(csv_dir="logs", epochs=50)
    trainer.train(epochs=50)
