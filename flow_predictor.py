# flow_predictor.py
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import Dataset, DataLoader
import numpy as np
import pandas as pd
import glob, os

# config
TIMESTEPS_IN = 8
TIMESTEPS_OUT = 1
BATCH = 32
LR = 1e-3
EPOCHS = 50
NUM_LANES = None  # inferred from CSVs

class TimeseriesDataset(Dataset):
    def __init__(self, csv_files, timesteps_in=TIMESTEPS_IN, timesteps_out=TIMESTEPS_OUT):
        self.samples = []
        self.num_lanes = None
        for f in csv_files:
            df = pd.read_csv(f)
            dens_cols = [c for c in df.columns if c.startswith('density_lane_')]
            if len(dens_cols) == 0:
                continue
            dens_cols = sorted(dens_cols, key=lambda s: int(s.split('_')[-1]))
            inferred_lanes = len(dens_cols)
            if self.num_lanes is None:
                self.num_lanes = inferred_lanes
            elif inferred_lanes != self.num_lanes:
                # Keep dataset shape consistent across files.
                continue
            arr = df[dens_cols].values.astype(np.float32)  # (T, num_lanes)
            # normalize per-file to [0,1] by its max (avoid div by 0)
            maxv = max(1.0, float(arr.max()))
            arr = arr / maxv
            T = len(arr)
            for i in range(T - timesteps_in - timesteps_out + 1):
                inp = arr[i:i+timesteps_in]   # shape (timesteps_in, num_lanes)
                out = arr[i+timesteps_in:i+timesteps_in+timesteps_out]  # (timesteps_out, num_lanes)
                self.samples.append((inp.copy(), out.copy()))
        if len(self.samples) == 0:
            raise RuntimeError("No samples found. Check CSVs and density column names.")

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        inp, out = self.samples[idx]
        # inp: (T_in, num_lanes) -> convert to (1, 1, T_in, num_lanes) as (batch,channels,T,H)
        x = np.transpose(inp, (1,0))          # (num_lanes, T_in)
        x = x[np.newaxis, np.newaxis, ...]    # (1, 1, num_lanes, T_in)
        # we want (channels=1, T_in, H=num_lanes) convention used below -> transpose:
        x = np.transpose(x, (0,1,3,2))        # (1,1,T_in,num_lanes)
        x = torch.from_numpy(x).float().squeeze(0)  # (1, T_in, num_lanes) -> squeeze batch dim for DataLoader batching
        # prepare y as flat vector: (timesteps_out, num_lanes) -> (num_lanes * timesteps_out,)
        y = out.transpose(1,0).reshape(-1) if out.ndim == 2 else out.reshape(-1)
        y = torch.from_numpy(y).float()
        return x, y

class Small3DPredictor(nn.Module):
    def __init__(self, in_T=TIMESTEPS_IN, in_H=1, out_size=TIMESTEPS_OUT):
        super().__init__()
        # input x: (batch, channels=1, T, H)
        self.conv1 = nn.Conv2d(1, 16, kernel_size=(3,3), padding=(1,1))
        self.conv2 = nn.Conv2d(16, 32, kernel_size=(3,3), padding=(1,1))
        self.pool = nn.AdaptiveAvgPool2d((1,1))  # collapse variable spatial dims
        self.fc = nn.Linear(32, out_size)

    def forward(self, x):
        # x: (batch, 1, T, H)
        h = torch.relu(self.conv1(x))
        h = torch.relu(self.conv2(h))
        h = self.pool(h)            # (batch, 32, 1, 1)
        h = h.view(h.size(0), -1)   # (batch, 32)
        out = self.fc(h)            # (batch, out_size)
        return out

def train(csv_pattern='logs/*_timeseries.csv'):
    files = glob.glob(csv_pattern)
    if not files:
        raise RuntimeError(f"No files matched pattern: {csv_pattern}")
    ds = TimeseriesDataset(files, TIMESTEPS_IN, TIMESTEPS_OUT)
    loader = DataLoader(ds, batch_size=BATCH, shuffle=True, drop_last=False)
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    num_lanes = ds.num_lanes if ds.num_lanes is not None else 1
    model = Small3DPredictor(in_T=TIMESTEPS_IN, in_H=num_lanes, out_size=num_lanes*TIMESTEPS_OUT).to(device)
    opt = optim.Adam(model.parameters(), lr=LR)
    loss_fn = nn.MSELoss()
    for epoch in range(EPOCHS):
        total = 0.0
        count = 0
        model.train()
        for x, y in loader:
            # x shape: (batch, 1, T, H)
            # our dataset returned x without leading batch dim squeeze, so ensure shape
            if x.dim() == 3:
                # (batch, T, H) -> add channel dim at position 1
                x = x.unsqueeze(1)
            x = x.to(device)
            y = y.to(device)
            pred = model(x)  # (batch, out_size)
            loss = loss_fn(pred, y)
            opt.zero_grad(); loss.backward(); opt.step()
            total += loss.item()
            count += 1
        print(f"Epoch {epoch+1}/{EPOCHS} loss:{(total/count):.6f}")
    torch.save(model.state_dict(), 'flow_predictor.pth')
    print("Saved predictor as flow_predictor.pth")

if __name__ == '__main__':
    train()
