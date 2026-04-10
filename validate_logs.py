import glob
import os

import numpy as np
import pandas as pd

from traffic_env import TrafficReplayEnv
from traffic_utils import extract_density_matrix, infer_num_lanes_from_df


LOG_DIR = "logs"
CSV_PATTERN = os.path.join(LOG_DIR, "*_timeseries.csv")


def main():
    csv_files = sorted(glob.glob(CSV_PATTERN))
    if not csv_files:
        raise FileNotFoundError(f"No CSVs found with pattern: {CSV_PATTERN}")

    print(f"Found {len(csv_files)} time series CSV(s) in {LOG_DIR}")

    rows = []
    for path in csv_files:
        df = pd.read_csv(path)
        try:
            n_lanes = infer_num_lanes_from_df(df)
        except Exception as e:
            rows.append(
                {
                    "csv_path": path,
                    "num_lanes": None,
                    "num_rows": len(df),
                    "status": f"invalid: {e}",
                }
            )
            continue

        dens = extract_density_matrix(df, num_lanes=n_lanes)
        if dens.shape[1] != n_lanes:
            status = "invalid: extraction lane mismatch"
        elif len(df) < 2:
            status = "invalid: too few rows for env.step()"
        elif not np.isfinite(dens).all():
            status = "invalid: NaN/inf densities"
        else:
            status = "ok"

        rows.append(
            {
                "csv_path": path,
                "num_lanes": n_lanes,
                "num_rows": len(df),
                "status": status,
                "density_max": float(np.max(dens)) if len(df) else 0.0,
            }
        )

    report = pd.DataFrame(rows)
    ok_count = int((report["status"] == "ok").sum())
    print(f"\nValidation summary: ok={ok_count}/{len(rows)}")
    print(report.sort_values(["num_lanes", "num_rows"], ascending=[True, False]).to_string(index=False))

    out_path = os.path.join(LOG_DIR, "logs_validation_report.csv")
    report.to_csv(out_path, index=False)
    print(f"\nSaved report: {out_path}")


if __name__ == "__main__":
    main()

