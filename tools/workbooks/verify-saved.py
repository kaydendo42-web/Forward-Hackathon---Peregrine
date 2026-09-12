"""Read-only OOXML verification for the four synthetic FY25 deliverables."""
import csv
import json
import posixpath
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[2]
NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL_ID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
manifest = json.loads((ROOT / "fixtures/fy25/manifest.json").read_text())
report = json.loads((ROOT / "outputs/fy25-baseline/verification/verification.json").read_text())
formula_error_types = {"#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A", "#NUM!", "#NULL!", "#SPILL!", "#CALC!"}

def cell_value(cell, shared):
    if cell is None:
        return None
    typ = cell.get("t")
    val = cell.find("s:v", NS)
    if typ == "inlineStr":
        return "".join(cell.itertext())
    if val is None:
        return None
    if typ == "s":
        return shared[int(val.text)]
    if typ in {"str", "e"}:
        return val.text
    if typ == "b":
        return val.text == "1"
    num = float(val.text)
    return int(num) if num.is_integer() else num

for entity in manifest["entities"]:
    source = ROOT / entity["workbook_path"]
    assert source.read_bytes() == (ROOT / "public/samples/fy25" / entity["workbook_filename"]).read_bytes()
    with ZipFile(source) as archive:
        assert archive.testzip() is None
        names = archive.namelist()
        assert not any("vbaProject" in n or "/externalLinks/" in n for n in names)
        shared = []
        if "xl/sharedStrings.xml" in names:
            shared = ["".join(item.itertext()) for item in ET.fromstring(archive.read("xl/sharedStrings.xml"))]
        book = ET.fromstring(archive.read("xl/workbook.xml"))
        rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))}
        sheets = {}
        for sheet in book.find("s:sheets", NS):
            target = rels[sheet.get(REL_ID)]
            target = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
            sheets[sheet.get("name")] = ET.fromstring(archive.read(target))
        expected_report = next(r for r in report["results"] if r["entity_id"] == entity["entity_id"])
        assert list(sheets) == expected_report["sheets"]
        tables = {t.get("name"): t for n in names if n.startswith("xl/tables/") and n.endswith(".xml") for t in [ET.fromstring(archive.read(n))]}
        assert tables["Peregrine_Metadata"].get("ref") == "A6:B16"
        assert tables["Peregrine_Lines"].get("ref") == f"A6:L{6 + len(entity['lines'])}"
        assert [c.get("name") for c in tables["Peregrine_Lines"].find("s:tableColumns", NS)] == manifest["line_columns"]
        assert [c.get("name") for c in tables["Peregrine_Metadata"].find("s:tableColumns", NS)] == ["key", "value"]
        metadata_cells = {c.get("r"): c for c in sheets["Metadata"].findall(".//s:c", NS)}
        metadata = {cell_value(metadata_cells.get(f"A{r}"), shared): cell_value(metadata_cells.get(f"B{r}"), shared) for r in range(7, 17)}
        assert metadata == {"schema_version": "1", "workbook_id": f"FY25-{entity['entity_id']}", "entity_id": entity["entity_id"], "entity_name": entity["entity_name"], "entity_type": entity["entity_type"], "financial_year": 2025, "synthetic": "true", "template_version": "1", "baseline_version": 1, "status": "synthetic_reviewed"}
        data_cells = {c.get("r"): c for c in sheets["Data"].findall(".//s:c", NS)}
        for r, line in enumerate(entity["lines"], 7):
            for col, field in enumerate(manifest["line_columns"]):
                cell = data_cells.get(f"{chr(65 + col)}{r}")
                assert cell is None or cell.find("s:f", NS) is None
                assert cell_value(cell, shared) == line[field], (entity["entity_id"], field, r)
        for sh_name, sheet in sheets.items():
            assert not any(c.get("t") == "e" or cell_value(c, shared) in formula_error_types for c in sheet.findall(".//s:c", NS))
        for test in expected_report["formula_assertions"]:
            cell = sheets[test["sheet"]].find(f".//s:c[@r='{test['cell']}']", NS)
            assert cell.find("s:f", NS) is not None
            assert cell_value(cell, shared) == test["expected"], test
        for sh_name in ["Data", "Evidence"]:
            pane = sheets[sh_name].find("s:sheetViews/s:sheetView/s:pane", NS)
            assert pane is not None and pane.get("state") == "frozen"
            assert pane.get("xSplit") == "2" and pane.get("ySplit") == "6"
    with (ROOT / "fixtures/fy25" / entity["evidence_filename"]).open(newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert len(rows) == len(entity["lines"])
    for line, evidence in zip(entity["lines"], rows):
        assert evidence["document_id"] == line["source_ref"]
        for field in ["line_id", "entity_id", "component", "currency", "basis"]:
            assert evidence[field] == line[field]
        assert int(evidence["financial_year"]) == 2025
        amount = None if evidence["amount"] == "" else float(evidence["amount"])
        assert amount == line["amount"]
    print(f"{entity['entity_id']}: saved metadata, {len(entity['lines'])} lines, formula caches, tables, panes, evidence and identical public copy verified")
print("All four OOXML workbooks verified without modifying their bytes.")
