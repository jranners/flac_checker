"""Embedded dark-mode spectrogram display."""

from __future__ import annotations

from matplotlib.backends.backend_qtagg import FigureCanvasQTAgg
from matplotlib.figure import Figure
import numpy as np

from analyzer import AnalysisResult


class SpectrogramWidget(FigureCanvasQTAgg):
    def __init__(self, parent=None) -> None:
        self.figure = Figure(figsize=(8, 3.8), dpi=100, facecolor="#181B22")
        super().__init__(self.figure)
        self.setParent(parent)
        self.axes = self.figure.add_subplot(111)
        self._empty()

    def _empty(self) -> None:
        self.axes.clear()
        self.axes.set_facecolor("#181B22")
        self.axes.text(
            0.5,
            0.5,
            "The analyzed spectrogram will appear here",
            color="#9CA3AF",
            ha="center",
            va="center",
            transform=self.axes.transAxes,
        )
        self.axes.set_axis_off()
        self.figure.tight_layout()
        self.draw_idle()

    def show_result(self, result: AnalysisResult) -> None:
        self.figure.clear()
        self.axes = self.figure.add_subplot(111)
        self.axes.set_facecolor("#181B22")
        times = result.times
        frequencies_khz = result.frequencies / 1000.0
        maximum_db = float(np.max(result.spectrogram_db))
        image = self.axes.pcolormesh(
            times,
            frequencies_khz,
            result.spectrogram_db,
            shading="auto",
            cmap="magma",
            vmin=maximum_db - 80.0,
            vmax=maximum_db,
        )
        if result.cutoff_hz is not None:
            self.axes.axhline(
                result.cutoff_hz / 1000.0,
                color="#F59E0B",
                linestyle="--",
                linewidth=1.5,
                label=f"Detected cutoff: {result.cutoff_hz / 1000:.1f} kHz",
            )
            self.axes.legend(loc="upper right", facecolor="#181B22", edgecolor="#262B36")
        self.axes.set_ylim(0, result.sample_rate / 2000.0)
        self.axes.set_xlabel("Time (s)", color="#9CA3AF")
        self.axes.set_ylabel("Frequency (kHz)", color="#9CA3AF")
        self.axes.tick_params(colors="#9CA3AF")
        for spine in self.axes.spines.values():
            spine.set_color("#414958")
        colorbar = self.figure.colorbar(image, ax=self.axes, pad=0.02)
        colorbar.set_label("Level (dB)", color="#9CA3AF")
        colorbar.ax.tick_params(colors="#9CA3AF")
        self.figure.tight_layout()
        self.draw_idle()
