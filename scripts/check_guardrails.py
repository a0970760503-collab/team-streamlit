#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""開發紅線靜態檢查器 (Guardrails Static Checker)

對應 .kiro/steering/guardrails.md 中可「靜態」驗證的性質 P1-P5、P10（fallback 假價）、P11（檔案編碼）。
P6（round-trip 不變性）、P7／P8（Bedrock 並行度與間隔）屬執行期性質，
須由 property-based test 覆蓋，不在本檔範圍。

用法:
    python scripts/check_guardrails.py                 # 全專案掃描
    python scripts/check_guardrails.py <file> [file..] # 只掃指定檔案（hook 用）

退出碼: 0 = 全數通過；1 = 發現違規
"""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = PROJECT_ROOT / "web"
ALLOWED_PORT = 8080
SKIP_PARTS = {".git", "target", "__pycache__", "venv", ".venv", "node_modules"}

# P10：禁止硬編碼 fallback 假價，斷線時必須明示不可用而非顯示假數字
BANNED_FALLBACK_LITERALS = (r"\b2411\.2\b", r"\b5200\.0\b", r"\b2100000\.0\b", r"\b2411\.20\b")
FALLBACK_SCAN_SUFFIXES = {".py", ".java", ".js"}

BANNED_FRONTEND = (
    r"\breact\b", r"\bvue\b", r"chart\.js", r"chartjs",
    r"\bd3\.js\b", r"\bd3\.min\.js\b", r"\bjquery\b",
)
BIND_RE = re.compile(r"""["'](?:0\.0\.0\.0|127\.0\.0\.1|localhost)["']\s*,\s*(\d{2,5})""")
PORT_ASSIGN_RE = re.compile(r"^\s*(?:PORT|port)\s*=\s*(\d{2,5})\s*$", re.M)
ANY_HOST_RE = re.compile(r"""["']0\.0\.0\.0["']""")
SCRIPT_SRC_RE = re.compile(r"""<script[^>]*\ssrc\s*=\s*["']([^"']+)["']""", re.I)
FETCH_RE = re.compile(r"""fetch\(\s*[`"']([^`"']*)""")
ABSOLUTE_URL_RE = re.compile(r"^(?:[a-z][a-z0-9+.-]*:)?//", re.I)

TEXT_CALLS = {"run", "Popen", "check_output", "call", "check_call"}
# P11：專案文字檔必須是無 BOM 的 UTF-8
TEXT_SUFFIXES = {".py", ".md", ".json", ".js", ".html", ".css", ".txt", ".R", ".java", ".xml"}
# 只有這些 receiver 的 open() 才是檔案 I/O；webbrowser.open、os.popen 等不算
FILE_OPEN_RECEIVERS = {"io", "codecs"}
SUBPROCESS_RECEIVERS = {"subprocess", "sp"}


class Violation:
    def __init__(self, rule: str, path: Path, line: int, message: str) -> None:
        self.rule = rule
        self.path = path
        self.line = line
        self.message = message

    def __str__(self) -> str:
        try:
            rel = self.path.relative_to(PROJECT_ROOT)
        except ValueError:
            rel = self.path
        return "[{0}] {1}:{2} {3}".format(self.rule, rel.as_posix(), self.line, self.message)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def _line_of(source: str, index: int) -> int:
    return source.count("\n", 0, index) + 1


def _kwarg(node: ast.Call, name: str):
    for kw in node.keywords:
        if kw.arg == name:
            return kw.value
    return None


def _is_true(node) -> bool:
    return isinstance(node, ast.Constant) and node.value is True


def _resolve(node: ast.Call):
    """回傳 (receiver, name)。裸呼叫的 receiver 為 None；<mod>.<fn>() 回傳 mod 名稱。"""
    func = node.func
    if isinstance(func, ast.Name):
        return None, func.id
    if isinstance(func, ast.Attribute):
        receiver = func.value.id if isinstance(func.value, ast.Name) else None
        return receiver, func.attr
    return None, ""


def check_python_encoding(path: Path, out: list) -> None:
    """P5：文字模式 open()／read_text／write_text／text=True subprocess 必須帶 encoding。

    只認裸 open()／io／codecs 的 open，`webbrowser.open` 等同名方法不列入。
    """
    source = _read(path)
    try:
        tree = ast.parse(source, filename=str(path))
    except SyntaxError as exc:
        out.append(Violation("P5", path, exc.lineno or 0, "無法解析語法: {0}".format(exc.msg)))
        return

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        receiver, name = _resolve(node)

        is_file_open = name == "open" and (receiver is None or receiver in FILE_OPEN_RECEIVERS)
        is_path_text = name in {"read_text", "write_text"}
        is_subprocess = name in TEXT_CALLS and (receiver is None or receiver in SUBPROCESS_RECEIVERS)

        if is_file_open:
            mode_node = node.args[1] if len(node.args) > 1 else _kwarg(node, "mode")
            if isinstance(mode_node, ast.Constant) and isinstance(mode_node.value, str):
                mode = mode_node.value
            elif mode_node is None:
                mode = "r"
            else:
                mode = "?"
            if "b" in mode:
                continue
            if _kwarg(node, "encoding") is None:
                out.append(Violation("P5", path, node.lineno,
                                     "文字模式 open() 未指定 encoding='utf-8'"))

        elif is_path_text:
            if _kwarg(node, "encoding") is None:
                out.append(Violation("P5", path, node.lineno,
                                     "Path.{0}() 未指定 encoding='utf-8'".format(name)))

        elif is_subprocess:
            textish = _is_true(_kwarg(node, "text")) or _is_true(_kwarg(node, "universal_newlines"))
            if textish and _kwarg(node, "encoding") is None:
                out.append(Violation("P5", path, node.lineno,
                                     "subprocess {0}(text=True) 未指定 encoding='utf-8'".format(name)))


def check_python_ports(path: Path, out: list) -> None:
    """P1：對外監聽埠集合恆等於 {8080}。"""
    source = _read(path)
    for match in BIND_RE.finditer(source):
        port = int(match.group(1))
        if port != ALLOWED_PORT:
            out.append(Violation("P1", path, _line_of(source, match.start()),
                                 "綁定非 8080 埠: {0}".format(port)))
    for match in PORT_ASSIGN_RE.finditer(source):
        port = int(match.group(1))
        if port != ALLOWED_PORT:
            out.append(Violation("P1", path, _line_of(source, match.start()),
                                 "PORT 常數為 {0}，非 8080".format(port)))
    for match in ANY_HOST_RE.finditer(source):
        out.append(Violation("P1", path, _line_of(source, match.start()),
                             "綁定 0.0.0.0 對外曝露，應綁 127.0.0.1"))


def check_frontend_deps(paths: list, out: list) -> None:
    """P3：web/** 不得引用 react／vue／chart.js／d3。"""
    for path in paths:
        source = _read(path)
        for pattern in BANNED_FRONTEND:
            for match in re.finditer(pattern, source, re.I):
                out.append(Violation("P3", path, _line_of(source, match.start()),
                                     "出現禁用前端依賴: {0}".format(match.group(0))))


def check_html_scripts(paths: list, out: list) -> None:
    """P4：<script src> 僅可指向同目錄本地檔案。"""
    for path in paths:
        source = _read(path)
        for match in SCRIPT_SRC_RE.finditer(source):
            src = match.group(1)
            if ABSOLUTE_URL_RE.match(src) or "/" in src:
                out.append(Violation("P4", path, _line_of(source, match.start()),
                                     "script src 非同目錄本地檔案: {0}".format(src)))


def check_frontend_fetch(paths: list, out: list) -> None:
    """P2：前端所有 fetch() 必須是相對路徑。"""
    for path in paths:
        source = _read(path)
        for match in FETCH_RE.finditer(source):
            url = match.group(1)
            if ABSOLUTE_URL_RE.match(url):
                out.append(Violation("P2", path, _line_of(source, match.start()),
                                     "fetch() 使用絕對 URL: {0}".format(url)))


def check_fallback_literals(paths: list, out: list) -> None:
    """P10：程式碼不得出現已知的 fallback 假價字面值。"""
    for path in paths:
        if path.suffix not in FALLBACK_SCAN_SUFFIXES:
            continue
        if path.resolve() == Path(__file__).resolve():
            continue
        source = _read(path)
        for pattern in BANNED_FALLBACK_LITERALS:
            for match in re.finditer(pattern, source):
                out.append(Violation("P10", path, _line_of(source, match.start()),
                                     "出現 fallback 假價字面值: {0}".format(match.group(0))))


def check_file_encodings(paths: list, out: list) -> None:
    """P11：文字檔必須是無 BOM 的 UTF-8，禁止 UTF-16／cp950 落地。"""
    for path in paths:
        raw = path.read_bytes()
        if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
            out.append(Violation("P11", path, 1, "檔案為 UTF-16 編碼，必須轉為 UTF-8"))
            continue
        if raw[:3] == b"\xef\xbb\xbf":
            out.append(Violation("P11", path, 1, "檔案帶 UTF-8 BOM，必須移除"))
            continue
        if b"\x00" in raw[:4096]:
            out.append(Violation("P11", path, 1, "檔案含 null byte，疑為 UTF-16 無 BOM 編碼"))
            continue
        try:
            raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            out.append(Violation("P11", path, 1,
                                 "檔案非合法 UTF-8（位元組 {0}）".format(exc.start)))


def _wanted(path: Path) -> bool:
    return not any(part in SKIP_PARTS for part in path.parts)


def collect_targets(argv: list):
    if argv:
        given = [Path(arg).resolve() for arg in argv]
        files = [p for p in given if p.is_file()]
    else:
        files = [p for p in PROJECT_ROOT.rglob("*") if p.is_file() and _wanted(p)]

    python_files = [p for p in files if p.suffix == ".py"]
    web_files = []
    for p in files:
        try:
            p.relative_to(WEB_DIR)
        except ValueError:
            continue
        if p.suffix in {".js", ".html", ".css"}:
            web_files.append(p)
    html_files = [p for p in web_files if p.suffix == ".html"]
    js_files = [p for p in web_files if p.suffix == ".js"]
    text_files = [p for p in files if p.suffix in TEXT_SUFFIXES]
    return python_files, web_files, html_files, js_files, text_files


def main(argv: list) -> int:
    python_files, web_files, html_files, js_files, text_files = collect_targets(argv)
    violations: list = []

    for path in python_files:
        check_python_encoding(path, violations)
        check_python_ports(path, violations)
    check_frontend_deps(web_files, violations)
    check_html_scripts(html_files, violations)
    check_frontend_fetch(js_files, violations)
    check_fallback_literals(text_files, violations)
    check_file_encodings(text_files, violations)

    scanned = len(set(python_files) | set(web_files) | set(text_files))
    if not violations:
        print("紅線檢查通過：掃描 {0} 個檔案，未發現紅線違規。".format(scanned))
        return 0

    print("紅線檢查失敗：掃描 {0} 個檔案，發現 {1} 項違規。".format(scanned, len(violations)))
    for violation in sorted(violations, key=lambda v: (v.rule, str(v.path), v.line)):
        print("  " + str(violation))
    print("")
    print("修正指引：P5／P11 屬編碼問題可直接修正；")
    print("P1／P2／P3／P4／P10 屬架構紅線，不得自行變更架構，請回報 System Integrator。")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
