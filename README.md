# TrueFLAC

TrueFLAC is a macOS desktop application for inspecting FLAC metadata and finding
spectral cutoffs that may indicate an upscaled lossy transcode. Drag FLAC files
or folders into the app to analyze them; folder scans include nested directories.

## Requirements

- macOS 12 or later
- Python 3.11+
- Xcode Command Line Tools (for Python packages that need native builds)

## Install and run

If `soundfile` cannot find its audio backend, install `libsndfile` first:

```bash
brew install libsndfile
```

Then create an isolated environment and start the app:

```bash
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
python main.py
```

The analysis is heuristic: a spectral cutoff can flag a likely lossy source but
cannot prove how a file was created. Quiet, bandwidth-limited, or unusual
recordings may need manual review in the spectrogram.
