"""Main TrueFLAC window and file-list interactions."""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt, Signal, QThreadPool
from PySide6.QtGui import QDragEnterEvent, QDropEvent
from PySide6.QtWidgets import (
    QFileDialog,
    QFrame,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMenu,
    QPushButton,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from analyzer import (
    FAKE_TRANSCODE,
    SUSPICIOUS,
    TRUE_LOSSLESS,
    AnalysisResult,
)
from ui.spectrogram_widget import SpectrogramWidget
from worker import AnalysisWorker


STATUS_COLORS = {
    TRUE_LOSSLESS: "#10B981",
    SUSPICIOUS: "#F59E0B",
    FAKE_TRANSCODE: "#EF4444",
    "ANALYZING": "#9CA3AF",
    "ERROR": "#EF4444",
}
STATUS_LABELS = {
    TRUE_LOSSLESS: "TRUE LOSSLESS",
    SUSPICIOUS: "SUSPICIOUS",
    FAKE_TRANSCODE: "FAKE TRANSCODE",
    "ANALYZING": "ANALYZING…",
    "ERROR": "ERROR",
}


class DropFrame(QFrame):
    files_dropped = Signal(list)

    def __init__(self) -> None:
        super().__init__()
        self.setAcceptDrops(True)
        self.setObjectName("panel")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 14, 12, 14)
        title = QLabel("Drop FLAC files or folders")
        title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        title.setObjectName("section-title")
        hint = QLabel("Folders are scanned recursively")
        hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        hint.setObjectName("muted")
        layout.addWidget(title)
        layout.addWidget(hint)

    def dragEnterEvent(self, event: QDragEnterEvent) -> None:
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
        else:
            event.ignore()

    def dropEvent(self, event: QDropEvent) -> None:
        self.files_dropped.emit(
            [url.toLocalFile() for url in event.mimeData().urls() if url.isLocalFile()]
        )
        event.acceptProposedAction()


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("TrueFLAC")
        self.resize(1280, 820)
        self.setMinimumSize(900, 600)
        self.setAcceptDrops(True)
        self.thread_pool = QThreadPool.globalInstance()
        self.results: dict[str, AnalysisResult] = {}
        self.errors: dict[str, str] = {}
        self.workers: dict[str, AnalysisWorker] = {}
        self._build_ui()

    def _build_ui(self) -> None:
        root = QWidget()
        root_layout = QVBoxLayout(root)
        root_layout.setContentsMargins(22, 18, 22, 20)
        root_layout.setSpacing(16)

        header = QHBoxLayout()
        title = QLabel("TrueFLAC")
        title.setObjectName("title")
        subtitle = QLabel("Lossless audio authenticity checker")
        subtitle.setObjectName("muted")
        brand = QVBoxLayout()
        brand.setSpacing(1)
        brand.addWidget(title)
        brand.addWidget(subtitle)
        header.addLayout(brand)
        header.addStretch(1)
        add_button = QPushButton("Add Files / Folder")
        add_button.setObjectName("primary")
        add_button.clicked.connect(self._show_add_menu)
        clear_button = QPushButton("Clear List")
        clear_button.clicked.connect(self.clear_list)
        header.addWidget(add_button)
        header.addWidget(clear_button)
        root_layout.addLayout(header)

        splitter = QSplitter(Qt.Orientation.Horizontal)
        splitter.setChildrenCollapsible(False)
        sidebar = QWidget()
        sidebar_layout = QVBoxLayout(sidebar)
        sidebar_layout.setContentsMargins(0, 0, 8, 0)
        sidebar_layout.setSpacing(12)
        self.drop_frame = DropFrame()
        self.drop_frame.files_dropped.connect(self.add_paths)
        sidebar_layout.addWidget(self.drop_frame)
        sidebar_heading = QHBoxLayout()
        section_label = QLabel("FILES")
        section_label.setObjectName("section-title")
        self.file_count = QLabel("0")
        self.file_count.setObjectName("muted")
        sidebar_heading.addWidget(section_label)
        sidebar_heading.addStretch(1)
        sidebar_heading.addWidget(self.file_count)
        sidebar_layout.addLayout(sidebar_heading)
        self.file_list = QListWidget()
        self.file_list.currentItemChanged.connect(self._selection_changed)
        sidebar_layout.addWidget(self.file_list, 1)
        splitter.addWidget(sidebar)

        self.detail_container = QWidget()
        self.detail_layout = QVBoxLayout(self.detail_container)
        self.detail_layout.setContentsMargins(8, 0, 0, 0)
        self.detail_layout.setSpacing(14)
        splitter.addWidget(self.detail_container)
        splitter.setSizes([350, 850])
        root_layout.addWidget(splitter, 1)
        self.setCentralWidget(root)
        self._show_empty()

    def _show_add_menu(self) -> None:
        menu = QMenu(self)
        files_action = menu.addAction("Choose FLAC files…")
        folder_action = menu.addAction("Choose folder…")
        selected = menu.exec(self.sender().mapToGlobal(self.sender().rect().bottomLeft()))
        if selected == files_action:
            paths, _ = QFileDialog.getOpenFileNames(
                self, "Add FLAC files", "", "FLAC audio (*.flac)"
            )
            self.add_paths(paths)
        elif selected == folder_action:
            folder = QFileDialog.getExistingDirectory(self, "Choose folder")
            if folder:
                self.add_paths([folder])

    def add_paths(self, paths: list[str]) -> None:
        discovered: list[Path] = []
        for raw_path in paths:
            path = Path(raw_path).expanduser()
            if path.is_dir():
                try:
                    discovered.extend(
                        candidate
                        for candidate in path.rglob("*")
                        if candidate.is_file() and candidate.suffix.lower() == ".flac"
                    )
                except OSError as exc:
                    self.statusBar().showMessage(f"Unable to scan {path}: {exc}", 6000)
            elif path.is_file() and path.suffix.lower() == ".flac":
                discovered.append(path)

        existing = {
            self.file_list.item(index).data(Qt.ItemDataRole.UserRole)
            for index in range(self.file_list.count())
        }
        added = 0
        for path in discovered:
            normalized = str(path.resolve())
            if normalized in existing:
                continue
            existing.add(normalized)
            item = QListWidgetItem()
            item.setData(Qt.ItemDataRole.UserRole, normalized)
            item.setSizeHint(item.sizeHint())
            self.file_list.addItem(item)
            self._update_item(item, "ANALYZING")
            self._start_analysis(normalized)
            added += 1
        self.file_count.setText(str(self.file_list.count()))
        if added == 0 and paths:
            self.statusBar().showMessage("No new .flac files found.", 4000)

    def _start_analysis(self, path: str) -> None:
        worker = AnalysisWorker(path)
        worker.signals.result.connect(self._analysis_succeeded)
        worker.signals.error.connect(self._analysis_failed)
        worker.signals.finished.connect(self._analysis_finished)
        self.workers[path] = worker
        self.thread_pool.start(worker)

    def _analysis_succeeded(self, result: AnalysisResult) -> None:
        self.results[result.path] = result
        self.errors.pop(result.path, None)
        item = self._find_item(result.path)
        if item is not None:
            self._update_item(item, result.status, result)
            if item is self.file_list.currentItem():
                self._show_result(result)

    def _analysis_failed(self, path: str, message: str) -> None:
        self.errors[path] = message
        item = self._find_item(path)
        if item is not None:
            self._update_item(item, "ERROR", error=message)
            if item is self.file_list.currentItem():
                self._show_error(path, message)

    def _analysis_finished(self, path: str) -> None:
        self.workers.pop(path, None)

    def _update_item(
        self,
        item: QListWidgetItem,
        status: str,
        result: AnalysisResult | None = None,
        error: str | None = None,
    ) -> None:
        item.setText("")
        row = QWidget()
        layout = QVBoxLayout(row)
        layout.setContentsMargins(5, 2, 5, 2)
        layout.setSpacing(4)
        path = item.data(Qt.ItemDataRole.UserRole)
        name = QLabel(Path(path).name)
        name.setToolTip(path)
        name.setStyleSheet("font-weight: 600;")
        detail = QLabel(
            f"{result.sample_rate / 1000:g} kHz · {result.bit_depth}-bit"
            if result
            else (error or "Reading metadata…")
        )
        detail.setObjectName("muted")
        badge = QLabel(STATUS_LABELS.get(status, status))
        color = STATUS_COLORS.get(status, "#9CA3AF")
        badge.setStyleSheet(
            f"color: {color}; font-size: 10px; font-weight: 700; letter-spacing: 0.5px;"
        )
        layout.addWidget(name)
        layout.addWidget(detail)
        layout.addWidget(badge)
        item.setSizeHint(row.sizeHint())
        self.file_list.setItemWidget(item, row)

    def _find_item(self, path: str) -> QListWidgetItem | None:
        for index in range(self.file_list.count()):
            item = self.file_list.item(index)
            if item.data(Qt.ItemDataRole.UserRole) == path:
                return item
        return None

    def _selection_changed(self, current: QListWidgetItem | None, _previous) -> None:
        if current is None:
            self._show_empty()
            return
        path = current.data(Qt.ItemDataRole.UserRole)
        if path in self.results:
            self._show_result(self.results[path])
        elif path in self.errors:
            self._show_error(path, self.errors[path])
        else:
            self._show_loading(path)

    def _clear_detail(self) -> None:
        while self.detail_layout.count():
            item = self.detail_layout.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.deleteLater()

    def _show_empty(self) -> None:
        self._clear_detail()
        panel = QFrame()
        panel.setObjectName("panel")
        layout = QVBoxLayout(panel)
        layout.addStretch(1)
        title = QLabel("Drop FLAC files to get started")
        title.setObjectName("section-title")
        title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        subtitle = QLabel("Analyze spectral content, metadata, and likely lossy cutoffs.")
        subtitle.setObjectName("muted")
        subtitle.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(title)
        layout.addWidget(subtitle)
        layout.addStretch(1)
        self.detail_layout.addWidget(panel, 1)

    def _show_loading(self, path: str) -> None:
        self._clear_detail()
        label = QLabel(f"Analyzing {Path(path).name}…")
        label.setObjectName("section-title")
        label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.detail_layout.addWidget(label, 1)

    def _show_error(self, path: str, message: str) -> None:
        self._clear_detail()
        panel = QFrame()
        panel.setObjectName("panel")
        layout = QVBoxLayout(panel)
        title = QLabel(f"Unable to analyze {Path(path).name}")
        title.setStyleSheet("color: #EF4444; font-size: 17px; font-weight: 700;")
        explanation = QLabel(message)
        explanation.setObjectName("muted")
        explanation.setWordWrap(True)
        layout.addWidget(title)
        layout.addWidget(explanation)
        layout.addStretch(1)
        self.detail_layout.addWidget(panel, 1)

    def _show_result(self, result: AnalysisResult) -> None:
        self._clear_detail()
        color = STATUS_COLORS[result.status]
        verdict = QFrame()
        verdict.setObjectName("card")
        verdict_layout = QVBoxLayout(verdict)
        verdict_layout.setContentsMargins(20, 16, 20, 16)
        heading = QHBoxLayout()
        status = QLabel(STATUS_LABELS[result.status])
        status.setStyleSheet(f"color: {color}; font-size: 18px; font-weight: 750;")
        confidence = QLabel(f"{result.confidence}% confidence")
        confidence.setObjectName("muted")
        heading.addWidget(status)
        heading.addStretch(1)
        heading.addWidget(confidence)
        verdict_layout.addLayout(heading)
        cutoff_text = (
            f"Detected cutoff: {result.cutoff_hz / 1000:.1f} kHz"
            if result.cutoff_hz is not None
            else "No characteristic cutoff detected"
        )
        cutoff = QLabel(cutoff_text)
        cutoff.setStyleSheet("font-size: 14px; font-weight: 600;")
        explanation = QLabel(result.explanation)
        explanation.setObjectName("muted")
        explanation.setWordWrap(True)
        verdict_layout.addWidget(cutoff)
        verdict_layout.addWidget(explanation)
        self.detail_layout.addWidget(verdict)

        grid = QHBoxLayout()
        duration = self._format_duration(result.duration)
        values = (
            ("SAMPLE RATE", f"{result.sample_rate / 1000:g} kHz"),
            ("BIT DEPTH", f"{result.bit_depth}-bit"),
            ("BITRATE", f"{result.bitrate // 1000} kbps"),
            ("DURATION · CHANNELS", f"{duration} · {result.channels} ch"),
        )
        for label, value in values:
            card = QFrame()
            card.setObjectName("card")
            card_layout = QVBoxLayout(card)
            card_layout.setContentsMargins(14, 11, 14, 11)
            key = QLabel(label)
            key.setObjectName("kpi-label")
            key.setStyleSheet("font-size: 10px; font-weight: 700;")
            metric = QLabel(value)
            metric.setStyleSheet("font-size: 16px; font-weight: 650;")
            card_layout.addWidget(key)
            card_layout.addWidget(metric)
            grid.addWidget(card, 1)
        self.detail_layout.addLayout(grid)

        spec_heading = QLabel("SPECTROGRAM")
        spec_heading.setObjectName("section-title")
        self.detail_layout.addWidget(spec_heading)
        spectrogram = SpectrogramWidget()
        spectrogram.show_result(result)
        self.detail_layout.addWidget(spectrogram, 1)
        if result.md5_hash:
            md5 = QLabel(f"FLAC MD5: {result.md5_hash}")
            md5.setObjectName("muted")
            self.detail_layout.addWidget(md5)

    def _format_duration(self, seconds: float) -> str:
        total = int(seconds)
        return f"{total // 60}:{total % 60:02d}"

    def clear_list(self) -> None:
        self.file_list.clear()
        self.results.clear()
        self.errors.clear()
        self.file_count.setText("0")
        self._show_empty()

    def dragEnterEvent(self, event: QDragEnterEvent) -> None:
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
        else:
            event.ignore()

    def dropEvent(self, event: QDropEvent) -> None:
        paths = [url.toLocalFile() for url in event.mimeData().urls() if url.isLocalFile()]
        self.add_paths(paths)
        event.acceptProposedAction()
