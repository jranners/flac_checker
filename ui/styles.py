"""Application-wide dark macOS-inspired Qt stylesheet."""


APP_STYLESHEET = """
QWidget {
    background: #0F1115;
    color: #F3F4F6;
    font-family: -apple-system, "Helvetica Neue", sans-serif;
    font-size: 13px;
}
QMainWindow, QDialog {
    background: #0F1115;
}
QFrame#card, QFrame#panel {
    background: #181B22;
    border: 1px solid #262B36;
    border-radius: 12px;
}
QLabel#title {
    font-size: 22px;
    font-weight: 700;
}
QLabel#section-title {
    font-size: 15px;
    font-weight: 600;
}
QLabel#muted, QLabel#kpi-label {
    color: #9CA3AF;
}
QPushButton {
    background: #252A34;
    border: 1px solid #343B49;
    border-radius: 8px;
    padding: 8px 13px;
    color: #F3F4F6;
}
QPushButton:hover {
    background: #303746;
}
QPushButton:pressed {
    background: #20242D;
}
QPushButton#primary {
    background: #10B981;
    border-color: #10B981;
    color: #06140F;
    font-weight: 650;
}
QPushButton#primary:hover {
    background: #34D399;
}
QListWidget {
    background: transparent;
    border: 0;
    outline: 0;
}
QListWidget::item {
    background: #181B22;
    border: 1px solid #262B36;
    border-radius: 9px;
    margin: 3px 0;
    padding: 8px;
}
QListWidget::item:selected {
    background: #222A32;
    border: 1px solid #10B981;
}
QScrollBar:vertical {
    background: transparent;
    width: 8px;
    margin: 0;
}
QScrollBar::handle:vertical {
    background: #414958;
    min-height: 24px;
    border-radius: 4px;
}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {
    height: 0;
}
"""
