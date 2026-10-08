"""Sube el número de versión de los archivos de la web (?v=N en index.html).

Ejecútalo antes de publicar cambios: así los navegadores descargan los archivos nuevos en vez de
mezclarlos con los que tenían guardados.
"""
import re
from pathlib import Path

index = Path(__file__).resolve().parent / "index.html"
text = index.read_text(encoding="utf-8")
current = max(int(v) for v in re.findall(r"\?v=(\d+)", text))
new = current + 1
index.write_text(re.sub(r"\?v=\d+", f"?v={new}", text), encoding="utf-8", newline="")
print(f"versión {current} -> {new}")
