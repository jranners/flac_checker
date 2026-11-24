"""Qt worker for running audio analysis away from the GUI thread."""

from __future__ import annotations

from PySide6.QtCore import QObject, QRunnable, Signal

from analyzer import AnalysisResult, analyze_file


class AnalysisSignals(QObject):
    result = Signal(object)
    error = Signal(str, str)
    finished = Signal(str)


class AnalysisWorker(QRunnable):
    def __init__(self, path: str) -> None:
        super().__init__()
        self.path = path
        self.signals = AnalysisSignals()
        self.setAutoDelete(True)

    def run(self) -> None:
        try:
            result: AnalysisResult = analyze_file(self.path)
            self.signals.result.emit(result)
        except Exception as exc:
            self.signals.error.emit(self.path, str(exc))
        finally:
            self.signals.finished.emit(self.path)
