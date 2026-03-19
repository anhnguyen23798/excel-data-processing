"use client";

import { ChangeEvent, useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import * as XLSXStyle from "xlsx-js-style";

type CellValue = string | number | boolean | null | undefined;
type RowData = Record<string, CellValue>;

type ReportSection = {
  sheetName: string;
  title: string;
  headers: string[];
  rows: string[][];
};

type ReportData = {
  pgsCode: string;
  summary: {
    totalHdt: number;
    twoDayCount: number;
    oneDayCount: number;
    area: string;
    totalSessions: number;
  };
  sections: ReportSection[];
};

type SessionSlot = {
  session: number;
  label: string;
  reserve: boolean;
};

const VIOLATION_SESSION_SLOTS: SessionSlot[] = [
  { session: 1, label: "8h - 8h30", reserve: false },
  { session: 2, label: "9h - 9h30", reserve: false },
  { session: 3, label: "10h - 10h30", reserve: false },
  { session: 4, label: "11h - 11h30", reserve: true },
  { session: 5, label: "13h30 - 14h", reserve: false },
  { session: 6, label: "14h30 - 15h", reserve: false },
  { session: 7, label: "15h30 - 16h", reserve: false },
  { session: 8, label: "16h30 - 17h", reserve: true },
];

const normalizeText = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");

const parseSheetTitle = (sheetName: string): string => {
  const regex = /Ngay(\d+)-Ca(\d+)-(\d{2})\.(\d{2})\s*-\s*(\d{2})\.(\d{2})-(\d{2})\.(\d{2})/i;
  const match = sheetName.match(regex);
  if (!match) return sheetName;

  const [, day, session, startHour, startMin, endHour, endMin, date, month] = match;
  return `NGÀY ${day} - CA ${session} (${startHour}:${startMin} - ${endHour}:${endMin}) - ${date}/${month}`;
};

const cleanHeader = (header: string): string => {
  const text = String(header ?? "").trim();
  if (!text) return "";
  if (text.includes(" - ")) return text.split(" - ")[0].trim();
  return text;
};

const toDisplayCell = (value: CellValue): string => String(value ?? "").trim();

const normalizePgsCode = (value: string): string => normalizeText(value);

const getSectionCouncilCodes = (rows: string[][]): string => {
  // [0]=STT, [1]=Tên HĐT, [2]=Mã HĐT, ...
  const seen = new Set<string>();
  const codes: string[] = [];
  for (const row of rows) {
    const code = String(row?.[2] ?? "").trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return codes.join(", ");
};

const parseSessionLabel = (sectionTitle: string): string => {
  // From: "NGÀY 1 - CA 1 (08:00 - 08:30) - 20/03"
  // To:   "Ca 1 (08:00 - 08:30)"
  const match = sectionTitle.match(/CA\s*(\d+)\s*\((\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})\)/i);
  if (!match) return sectionTitle;
  const [, session, start, end] = match;
  return `Ca ${session} (${start} - ${end})`;
};

const buildViolationSheetName = (sectionTitle: string): string => {
  // Make sheet name unique across days while staying short (<=31 chars).
  // Prefer: "N1-C1 08:00-08:30 20/03"
  const match = sectionTitle.match(
    /NGÀY\s*(\d+)\s*-\s*CA\s*(\d+)\s*\((\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})\)\s*-\s*(\d{2})\/(\d{2})/i
  );
  if (!match) {
    const fallback = sectionTitle.trim().replace(/[\\/?*[\]:]/g, " ").replace(/\s+/g, " ");
    return fallback.length > 31 ? fallback.slice(0, 31) : fallback;
  }

  const [, day, session, start, end, dd, mm] = match;
  // ":" is not allowed in Excel sheet names -> swap to "."
  const safeStart = start.replaceAll(":", ".");
  const safeEnd = end.replaceAll(":", ".");
  const base = `Ngày${day} - Ca${session}`;
  return base.length > 31 ? base.slice(0, 31) : base;
};

const parseDayAndSessionFromTitle = (sectionTitle: string): { day: number; session: number } | null => {
  const match = sectionTitle.match(/NGÀY\s*(\d+)\s*-\s*CA\s*(\d+)/i);
  if (!match) return null;
  return {
    day: Number(match[1]),
    session: Number(match[2]),
  };
};

const buildReportByPgs = (buffer: ArrayBuffer, pgsCode: string): ReportData => {
  const workbook = XLSX.read(buffer, { type: "array" });
  const pgsSheet = workbook.Sheets["Phân bổ chi tiết"];
  if (!pgsSheet) {
    throw new Error("Khong tim thay sheet 'Phan bo chi tiet'.");
  }

  const summaryRows = XLSX.utils.sheet_to_json<RowData>(pgsSheet, {
    defval: "",
    raw: false,
  });
  const normalizedPgs = normalizePgsCode(pgsCode);

  const selectedRows = summaryRows.filter((row) => {
    const day1 = normalizePgsCode(String(row["Phòng giám sát ngày 1"] ?? ""));
    const day2 = normalizePgsCode(String(row["Phòng giám sát ngày 2"] ?? ""));
    return day1 === normalizedPgs || day2 === normalizedPgs;
  });

  const hdtCodeSet = new Set(
    selectedRows.map((row) => toDisplayCell(row["Mã hội đồng"])).filter(Boolean)
  );

  const sections: ReportSection[] = [];

  for (const sheetName of workbook.SheetNames) {
    if (sheetName === "Phân bổ chi tiết") continue;

    const ws = workbook.Sheets[sheetName];
    if (!ws) continue;

    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false }) as CellValue[][];
    if (rows.length === 0) continue;

    const rawHeaders = (rows[0] ?? []).map((cell) => toDisplayCell(cell));
    const headers = rawHeaders.map((header, index) => (index >= 5 ? cleanHeader(header) : header));
    const dataRows = rows.slice(1);
    const matchedRows: string[][] = [];

    let includeContinuation = false;
    let lastHdtContext: { stt: string; name: string; code: string } | null = null;
    for (const row of dataRows) {
      const stt = toDisplayCell(row[0]);
      const name = toDisplayCell(row[1]);
      const code = toDisplayCell(row[2]);

      if (code) {
        includeContinuation = hdtCodeSet.has(code);
        if (includeContinuation) {
          lastHdtContext = { stt, name, code };
        } else {
          lastHdtContext = null;
        }
      }
      if (!includeContinuation) continue;

      const rowValues = row.map((cell) => toDisplayCell(cell));
      // Many Excel exports use merged cells, so continuation rows (room 2/3...)
      // often come with empty STT/Ten/Ma. We fill-down from the last matched HĐT row
      // to match the expected output like `theanh.xlsx`.
      if (lastHdtContext) {
        if (!rowValues[0]) rowValues[0] = lastHdtContext.stt;
        if (!rowValues[1]) rowValues[1] = lastHdtContext.name;
        if (!rowValues[2]) rowValues[2] = lastHdtContext.code;
      }
      const fixedLength = Math.max(headers.length, 9);
      while (rowValues.length < fixedLength) rowValues.push("");
      matchedRows.push(rowValues);
    }

    if (matchedRows.length > 0) {
      sections.push({
        sheetName,
        title: parseSheetTitle(sheetName),
        headers: [...headers, ...Array(Math.max(0, 9 - headers.length)).fill("")],
        rows: matchedRows,
      });
    }
  }

  const twoDayCount = selectedRows.filter(
    (row) => normalizeText(row["Phân loại"]) === normalizeText("Thi 2 ngày")
  ).length;
  const oneDayCount = selectedRows.length - twoDayCount;
  const areaSet = new Set(
    selectedRows.map((row) => toDisplayCell(row["Tỉnh/Thành phố"])).filter(Boolean)
  );

  return {
    pgsCode: pgsCode.trim(),
    summary: {
      totalHdt: selectedRows.length,
      twoDayCount,
      oneDayCount,
      area: Array.from(areaSet).join(", "),
      totalSessions: sections.length,
    },
    sections,
  };
};

export default function Home() {
  const [dataSource, setDataSource] = useState<"default" | "upload">("default");
  const [defaultBuffer, setDefaultBuffer] = useState<ArrayBuffer | null>(null);
  const [uploadBuffer, setUploadBuffer] = useState<ArrayBuffer | null>(null);
  const [fileName, setFileName] = useState("");
  const [pgsCode, setPgsCode] = useState("");
  const [report, setReport] = useState<ReportData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const activeBuffer = useMemo(
    () => (dataSource === "default" ? defaultBuffer : uploadBuffer),
    [dataSource, defaultBuffer, uploadBuffer]
  );
  const activeName = useMemo(() => {
    if (dataSource === "default") return "data.xlsx (public)";
    return fileName || "";
  }, [dataSource, fileName]);
  const canSearch = useMemo(() => Boolean(activeBuffer) && pgsCode.trim(), [activeBuffer, pgsCode]);

  const copyToClipboard = async (text: string) => {
    const value = String(text ?? "").trim();
    if (!value) return;
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  };

  const loadDefaultExcel = async () => {
    try {
      setLoading(true);
      setError("");
      setReport(null);
      const res = await fetch("/data.xlsx", { cache: "no-store" });
      if (!res.ok) {
        throw new Error("Khong the tai file mac dinh tu public/data.xlsx.");
      }
      const buffer = await res.arrayBuffer();
      setDefaultBuffer(buffer);
    } catch (e) {
      if (e instanceof Error && e.message) setError(e.message);
      else setError("Khong the tai file mac dinh tu public/data.xlsx.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Default data source: public/data.xlsx
    void loadDefaultExcel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const exportViolationTemplate = () => {
    if (!report) return;

    const headers = [
      "Ca thi",
      "Hội đồng",
      "Phòng thi",
      "Số lượng HS đăng ký",
      "Số lượng HS thực tế",
      "Hành vi vi phạm",
      "Time vi phạm (theo record)",
      "Hủy",
    ];

    const borderAll = {
      top: { style: "thin", color: { rgb: "000000" } },
      bottom: { style: "thin", color: { rgb: "000000" } },
      left: { style: "thin", color: { rgb: "000000" } },
      right: { style: "thin", color: { rgb: "000000" } },
    } as const;

    const styleHeader = {
      font: { bold: true, sz: 11, color: { rgb: "FF0000" } },
      fill: { fgColor: { rgb: "FFFF00" } },
      alignment: { vertical: "center", horizontal: "center", wrapText: true },
      border: borderAll,
    } as const;

    const styleCell = {
      font: { sz: 11, color: { rgb: "111827" } },
      alignment: { vertical: "top", horizontal: "left", wrapText: true },
      border: borderAll,
    } as const;

    const styleSessionCell = {
      font: { sz: 11, color: { rgb: "111827" } },
      alignment: { vertical: "center", horizontal: "left", wrapText: true },
      border: borderAll,
    } as const;

    const colWidths = [
      { wch: 22 }, // Ca thi
      { wch: 52 }, // Hoi dong
      { wch: 10 }, // Phong thi
      { wch: 18 }, // SL dang ky
      { wch: 18 }, // SL thuc te
      { wch: 40 }, // Hanh vi
      { wch: 26 }, // Time vi pham
      { wch: 10 }, // Huy
    ];

    const sectionsByDaySession = new Map<string, ReportSection>();
    const sectionDays = new Set<number>();
    for (const section of report.sections) {
      const daySession = parseDayAndSessionFromTitle(section.title);
      if (!daySession) continue;
      const { day, session } = daySession;
      sectionDays.add(day);
      sectionsByDaySession.set(`${day}-${session}`, section);
    }

    if (sectionDays.size === 0) {
      sectionDays.add(report.summary.twoDayCount > 0 ? 1 : 1);
      if (report.summary.twoDayCount > 0) sectionDays.add(2);
    }

    const orderedDays = Array.from(sectionDays).sort((a, b) => a - b);

    const wb = XLSXStyle.utils.book_new();
    const usedSheetNames = new Map<string, number>();

    for (const day of orderedDays) {
      for (const slot of VIOLATION_SESSION_SLOTS) {
        const section = sectionsByDaySession.get(`${day}-${slot.session}`);
        const sessionLabel = `Ca ${slot.session} (${slot.label})`;
        const rows: string[][] = [];
        const firstHeader = slot.reserve ? "Ca thi dự phòng" : "Ca thi";
        rows.push([firstHeader, ...headers.slice(1)]);

        const defaultRowCount = 6;
        if (!section) {
          rows.push([sessionLabel, "", "", "", "", "", "", ""]);
          for (let i = 1; i < defaultRowCount; i++) {
            rows.push(["", "", "", "", "", "", "", ""]);
          }
        } else {
          // Best-effort mapping from the “phân công” export:
          // [0]=STT, [1]=Tên HĐT, [2]=Mã HĐT, [3]=Phòng thi, [4]=SL đăng ký, ...
          const data = section.rows.map((r) => ({
            council: String(r[1] ?? "").trim(),
            room: String(r[3] ?? "").trim(),
            registered: String(r[4] ?? "").trim(),
          }));

          if (data.length === 0) {
            rows.push([sessionLabel, "", "", "", "", "", "", ""]);
          } else {
            for (let i = 0; i < data.length; i++) {
              const item = data[i];
              rows.push([
                i === 0 ? sessionLabel : "",
                item.council,
                item.room,
                item.registered,
                "", // actual
                "", // violation
                "", // time
                "", // cancel
              ]);
            }
          }

          while (rows.length - 1 < defaultRowCount) {
            rows.push(["", "", "", "", "", "", "", ""]);
          }
        }

        const ws = XLSXStyle.utils.aoa_to_sheet(rows) as XLSXStyle.WorkSheet & {
          "!cols"?: { wch?: number }[];
          "!merges"?: { s: { r: number; c: number }; e: { r: number; c: number } }[];
          "!freeze"?: { xSplit?: number; ySplit?: number };
        };

        ws["!cols"] = colWidths;
        ws["!freeze"] = { ySplit: 1 };

        // Merge "Ca thi" column vertically like the template image (if there is data)
        if (rows.length > 1) {
          ws["!merges"] = [
            {
              s: { r: 1, c: 0 },
              e: { r: rows.length - 1, c: 0 },
            },
          ];
          const addr = XLSXStyle.utils.encode_cell({ r: 1, c: 0 });
          ws[addr] = { t: "s", v: sessionLabel, s: styleSessionCell } as unknown as XLSXStyle.CellObject;
        }

        const range = XLSXStyle.utils.decode_range(ws["!ref"] ?? "A1:H1");
        for (let r = range.s.r; r <= range.e.r; r++) {
          for (let c = range.s.c; c <= range.e.c; c++) {
            const addr = XLSXStyle.utils.encode_cell({ r, c });
            const cell = ws[addr];
            if (!cell) continue;

            if (r === 0) {
              cell.s = styleHeader;
            } else if (c === 0 && r === 1 && rows.length > 1) {
              // already styled via ws[addr] assignment above
              cell.s = styleSessionCell;
            } else {
              cell.s = styleCell;
            }
          }
        }

        // Sheet name: Excel limit is 31 chars & must be unique
        const rawBase = section ? buildViolationSheetName(section.title) : `Ngày${day} - Ca${slot.session}`;
        const baseName = rawBase
          .trim()
          .replace(/[\\/?*[\]:]/g, " ")
          .replace(/\s+/g, " ")
          .slice(0, 31);
        const count = (usedSheetNames.get(baseName) ?? 0) + 1;
        usedSheetNames.set(baseName, count);
        const suffix = count === 1 ? "" : ` (${count})`;
        const uniqueName =
          suffix.length === 0 ? baseName : `${baseName.slice(0, Math.max(0, 31 - suffix.length))}${suffix}`;

        XLSXStyle.utils.book_append_sheet(wb, ws, uniqueName);
      }
    }

    XLSXStyle.writeFile(wb, `vi-pham-${report.pgsCode || "pgs"}.xlsx`);
  };

  const exportReport = () => {
    if (!report) return;

    const maxCols = report.sections.reduce((max, s) => Math.max(max, s.headers.length), 9);
    const emptyRow = Array.from({ length: maxCols }, () => "");

    const sheetRows: string[][] = [];
    const rowKinds: ("title" | "meta" | "blank" | "sectionTitle" | "header" | "data")[] = [];
    const sectionHeaderRowIndexes: number[] = [];
    const mergeRows: number[] = [];

    sheetRows.push([`PHAN CONG TRONG THI - ${report.pgsCode}`, ...emptyRow.slice(1)]);
    rowKinds.push("title");
    mergeRows.push(0);

    sheetRows.push([
      `Tong so HDT: ${report.summary.totalHdt}  |  Thi 2 ngay: ${report.summary.twoDayCount}  |  Chi thi ngay 1: ${report.summary.oneDayCount}  |  Khu vuc: ${report.summary.area || "N/A"}  |  Tong so ca: ${report.summary.totalSessions}`,
      ...emptyRow.slice(1),
    ]);
    rowKinds.push("meta");
    mergeRows.push(1);

    sheetRows.push([...emptyRow]);
    rowKinds.push("blank");

    report.sections.forEach((section) => {
      sheetRows.push([section.title, ...emptyRow.slice(1)]);
      rowKinds.push("sectionTitle");
      mergeRows.push(sheetRows.length - 1);

      const paddedHeaders = [...section.headers];
      while (paddedHeaders.length < maxCols) paddedHeaders.push("");
      sheetRows.push(paddedHeaders);
      rowKinds.push("header");
      sectionHeaderRowIndexes.push(sheetRows.length - 1);

      section.rows.forEach((row) => {
        const padded = [...row];
        while (padded.length < maxCols) padded.push("");
        sheetRows.push(padded);
        rowKinds.push("data");
      });

      sheetRows.push([...emptyRow]);
      rowKinds.push("blank");
    });

    const ws = XLSXStyle.utils.aoa_to_sheet(sheetRows) as XLSXStyle.WorkSheet & {
      "!cols"?: { wch?: number }[];
      "!merges"?: { s: { r: number; c: number }; e: { r: number; c: number } }[];
      "!freeze"?: { xSplit?: number; ySplit?: number };
    };

    // Column widths (rough but works well visually)
    // NOTE: Don't let long merged title/meta lines (col A) inflate widths.
    const colWidths = Array.from({ length: maxCols }, (_, c) => {
      const sample = sheetRows
        .slice(0, 300)
        .filter((_, rIdx) => rowKinds[rIdx] === "header" || rowKinds[rIdx] === "data")
        .map((r) => String(r[c] ?? ""))
        .reduce((m, v) => Math.max(m, v.length), 0);

      // Make "STT HĐT" (first column) smaller on export.
      const base = c === 0 ? 6 : c === 1 ? 46 : c === 2 ? 14 : c === 3 ? 8 : c === 4 ? 14 : 18;
      return Math.min(70, Math.max(base, Math.ceil(sample * 0.9)));
    });
    ws["!cols"] = colWidths.map((wch) => ({ wch }));

    // Merges for big title lines
    ws["!merges"] = mergeRows.map((r) => ({
      s: { r, c: 0 },
      e: { r, c: maxCols - 1 },
    }));

    // Freeze rows until first section header (keeps the first section header visible)
    const firstHeaderRow = sectionHeaderRowIndexes[0] ?? 3;
    ws["!freeze"] = { ySplit: firstHeaderRow + 1 };

    const borderAll = {
      top: { style: "thin", color: { rgb: "D4D4D8" } },
      bottom: { style: "thin", color: { rgb: "D4D4D8" } },
      left: { style: "thin", color: { rgb: "D4D4D8" } },
      right: { style: "thin", color: { rgb: "D4D4D8" } },
    } as const;

    const styleTitle = {
      font: { bold: true, sz: 16, color: { rgb: "111827" } },
      alignment: { vertical: "center", horizontal: "left", wrapText: true },
    } as const;
    const styleMeta = {
      font: { italic: true, sz: 11, color: { rgb: "374151" } },
      alignment: { vertical: "top", horizontal: "left", wrapText: true },
    } as const;
    const styleSectionTitle = {
      font: { bold: true, sz: 12, color: { rgb: "111827" } },
      fill: { fgColor: { rgb: "F4F4F5" } },
      alignment: { vertical: "center", horizontal: "left", wrapText: true },
    } as const;
    const styleHeader = {
      font: { bold: true, sz: 11, color: { rgb: "111827" } },
      fill: { fgColor: { rgb: "E5E7EB" } },
      alignment: { vertical: "center", horizontal: "center", wrapText: true },
      border: borderAll,
    } as const;
    const styleCell = {
      font: { sz: 11, color: { rgb: "111827" } },
      alignment: { vertical: "top", horizontal: "left", wrapText: true },
      border: borderAll,
    } as const;

    const range = XLSXStyle.utils.decode_range(ws["!ref"] ?? "A1:A1");
    for (let r = range.s.r; r <= range.e.r; r++) {
      const kind = rowKinds[r] ?? "data";
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSXStyle.utils.encode_cell({ r, c });
        const cell = ws[addr];
        if (!cell) continue;

        if (kind === "title") {
          cell.s = styleTitle;
        } else if (kind === "meta") {
          cell.s = styleMeta;
        } else if (kind === "sectionTitle") {
          cell.s = styleSectionTitle;
        } else if (kind === "header") {
          cell.s = styleHeader;
        } else if (kind === "data") {
          cell.s = styleCell;
        }
      }
    }

    const wb = XLSXStyle.utils.book_new();
    XLSXStyle.utils.book_append_sheet(wb, ws, report.pgsCode || "Ket qua");
    XLSXStyle.writeFile(wb, `ket-qua-${report.pgsCode || "pgs"}.xlsx`);
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setReport(null);
    setError("");

    if (!file) {
      setFileName("");
      setUploadBuffer(null);
      return;
    }

    try {
      setLoading(true);
      const buffer = await file.arrayBuffer();
      setUploadBuffer(buffer);
      setFileName(file.name);
      setDataSource("upload");
      if (pgsCode.trim()) {
        setReport(buildReportByPgs(buffer, pgsCode));
      }
    } catch {
      setError("Khong doc duoc file Excel. Vui long kiem tra dinh dang file.");
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (event: ChangeEvent<HTMLInputElement>) => {
    if (!event.target.value) {
      return;
    }
    const value = event.target.value.trim();
    setPgsCode(value);
    setError("");
    setReport(null);
  };

  const runSearch = async () => {
    if (!activeBuffer) {
      if (dataSource === "upload") {
        setError("Ban dang chon 'Du lieu upload' nhung chua chon file Excel.");
      } else {
        setError("Khong the tai du lieu mac dinh tu public/data.xlsx.");
      }
      return;
    }

    try {
      setLoading(true);
      const nextReport = buildReportByPgs(activeBuffer, pgsCode);
      setReport(nextReport);
      if (nextReport.summary.totalHdt === 0) {
        setError(`Khong tim thay du lieu cho ma phong giam sat: ${pgsCode}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message) {
        setError(e.message);
      } else {
        setError("Co loi khi xu ly du lieu trong file.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="mx-auto min-h-screen w-full max-w-7xl bg-zinc-50 px-6 py-10 text-zinc-900">
      <h1 className="text-2xl font-semibold text-zinc-900">Xử lý file phòng giám sát</h1>
      <p className="mt-2 text-sm text-zinc-700">
        Mặc định hệ thống dùng file <strong>data</strong> có sẵn. Bạn có thể chuyển sang <strong>dữ liệu upload</strong>{" "}
        để dùng file Excel bạn chọn. Nhập{" "}
        <strong>Mã phòng giám sát</strong> (ví dụ: PGS19), hệ thống sẽ tạo bảng kết quả theo từng ca thi như file mẫu.
      </p>

      <section className="mt-6 grid gap-4 rounded-xl border border-zinc-200 bg-white p-4">
        <div className="grid gap-2">
          <p className="text-sm font-medium">Nguồn dữ liệu</p>
          <div className="flex w-fit rounded-lg border border-zinc-200 bg-zinc-50 p-1 text-sm">
            <button
              type="button"
              onClick={() => {
                setDataSource("default");
                setError("");
                setReport(null);
                const input = document.getElementById("excel-input") as HTMLInputElement | null;
                if (input) input.value = "";
              }}
              className={[
                "rounded-md px-3 py-1.5",
                dataSource === "default"
                  ? "bg-white text-zinc-900 shadow-sm"
                  : "text-zinc-700 hover:bg-white/60",
              ].join(" ")}
            >
              Dữ liệu có sẵn
            </button>
            <button
              type="button"
              onClick={() => {
                setDataSource("upload");
                setError("");
                setReport(null);
              }}
              className={[
                "rounded-md px-3 py-1.5",
                dataSource === "upload" ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-700 hover:bg-white/60",
              ].join(" ")}
            >
              Dữ liệu upload
            </button>
          </div>
        </div>

        {dataSource === "upload" && (
          <>
            <label className="text-sm font-medium">File gốc (.xlsx, .xls)</label>
            <input
              id="excel-input"
              type="file"
              accept=".xlsx,.xls"
              onChange={handleFileChange}
              className="block w-full text-sm text-zinc-900 file:mr-4 file:rounded-md file:border file:border-zinc-200 file:bg-zinc-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-zinc-900 hover:file:bg-zinc-200"
            />
          </>
        )}

        <label className="text-sm font-medium">Mã phòng giám sát</label>
        <input
          type="text"
          value={pgsCode}
          onChange={handleSearch}
          placeholder="Ví dụ: PGS19"
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none ring-0 placeholder:text-zinc-400 focus:border-zinc-500"
        />

        <div className="flex gap-2">
          <button
            type="button"
            onClick={runSearch}
            disabled={!canSearch || loading}
            className="w-fit rounded-md bg-black px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Đang xử lý..." : "Tạo kết quả"}
          </button>
          <button
            type="button"
            onClick={exportReport}
            disabled={!report || loading}
            className="w-fit rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Export XLSX
          </button>
          <button
            type="button"
            onClick={exportViolationTemplate}
            disabled={!report || loading}
            className="w-fit rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Export file vi phạm
          </button>
        </div>
      </section>

      {activeName && (
        <p className="mt-4 text-sm text-zinc-700">
          Dang su dung: <strong>{activeName}</strong>
        </p>
      )}

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {report && !loading && (
        <section className="mt-6 space-y-5">
          <div className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-900">
            <p className="font-semibold text-zinc-900">PHÂN CÔNG TRONG THI - {report.pgsCode}</p>
            <p className="mt-1 text-zinc-700">
              Tổng số HĐT: {report.summary.totalHdt} | Thi 2 ngày: {report.summary.twoDayCount} | Chi thi ngày 1:{" "}
              {report.summary.oneDayCount} | Khu vực: {report.summary.area || "N/A"} | Tổng số ca:{" "}
              {report.summary.totalSessions}
            </p>
          </div>

          {report.sections.length === 0 ? (
            <p className="text-sm text-zinc-700">Không có ca thi nào phù hợp với mã phòng giám sát này.</p>
          ) : (
            report.sections.map((section) => (
              <div key={section.sheetName} className="rounded-lg border border-zinc-200 bg-white p-3 text-zinc-900">
                <h2 className="mb-3 text-sm font-semibold text-zinc-900">{section.title}</h2>
                {/* Danh sách mã hội đồng thi trong ca thi cách nhau bởi dấu phẩy*/}
                <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-zinc-700">
                  <span>Danh sách mã HĐT: {getSectionCouncilCodes(section.rows) || "Không có"}</span>
                  <button
                    type="button"
                    onClick={async () => {
                      const text = getSectionCouncilCodes(section.rows);
                      if (!text) return;
                      await copyToClipboard(text);
                      setCopiedKey(section.sheetName);
                      window.setTimeout(() => setCopiedKey((prev) => (prev === section.sheetName ? null : prev)), 1200);
                    }}
                    disabled={!getSectionCouncilCodes(section.rows)}
                    className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-zinc-900 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {copiedKey === section.sheetName ? "Đã copy" : "Copy"}
                  </button>
                </div>
                <div className="overflow-auto">
                  <table className="min-w-full border-collapse text-xs">
                    <thead>
                      <tr>
                        {section.headers.map((header, idx) => (
                          <th
                            key={`${section.sheetName}-h-${idx}`}
                            className="border border-zinc-300 bg-zinc-100 px-2 py-1 text-left font-medium text-zinc-900"
                          >
                            {header}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {section.rows.map((row, rowIndex) => (
                        <tr key={`${section.sheetName}-r-${rowIndex}`}>
                          {row.map((cell, cellIndex) => (
                            <td
                              key={`${section.sheetName}-r-${rowIndex}-c-${cellIndex}`}
                              className="border border-zinc-200 px-2 py-1 align-top text-zinc-900"
                            >
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          )}
        </section>
      )}
    </main>
  );
}
