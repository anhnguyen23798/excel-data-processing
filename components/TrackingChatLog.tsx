/* eslint-disable react/no-danger */
"use client";

import { useEffect, useMemo, useState } from "react";

type ChatMessage = {
  at: Date;
  dateText: string; // YYYY-MM-DD
  timeText: string; // HH:mm
  user: string;
  message: string;
  rawLine: string;
};

type CaGroup = {
  index: number;
  title: string;
  startTimeText: string;
  endTimeText: string;
  messages: ChatMessage[];
};

type CaSlot = {
  session: number;
  startTime: string; // HH:mm
  endTime: string; // HH:mm
};

// Khung giờ ca thi.
// Nếu dự án của bạn có lịch khác, chỉnh ở đây để map log -> đúng ca.
const CA_SCHEDULE: CaSlot[] = [
  { session: 1, startTime: "08:00", endTime: "08:30" },
  { session: 2, startTime: "09:00", endTime: "09:30" },
  { session: 3, startTime: "10:00", endTime: "10:30" },
  { session: 4, startTime: "11:00", endTime: "11:30" },
  { session: 5, startTime: "13:30", endTime: "14:00" },
  { session: 6, startTime: "14:30", endTime: "15:00" },
  { session: 7, startTime: "15:30", endTime: "16:00" },
  { session: 8, startTime: "16:30", endTime: "17:00" },
];

const parseWebexLine = (line: string): ChatMessage | null => {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Expected pattern from Webex chat export:
  // 2026-03-20 11:30 : user : message...
  const match = trimmed.match(
    /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*:\s*(.*?)\s*:\s*(.*)$/
  );
  if (!match) return null;

  const [, dateText, timeText, userRaw, messageRaw] = match;
  const [yearStr, monthStr, dayStr] = dateText.split("-");
  const [hourStr, minStr] = timeText.split(":");

  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minStr);

  if (![year, month, day, hour, minute].every((n) => Number.isFinite(n))) return null;

  const at = new Date(year, month - 1, day, hour, minute);
  return {
    at,
    dateText,
    timeText,
    user: userRaw.trim(),
    message: messageRaw.trim(),
    rawLine: trimmed,
  };
};

const parseHHmm = (hhmm: string): { hour: number; minute: number } | null => {
  const m = hhmm.trim().match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  return { hour, minute };
};

const buildCaWindowForMessage = (msg: ChatMessage, slot: CaSlot) => {
  const st = parseHHmm(slot.startTime);
  const et = parseHHmm(slot.endTime);
  if (!st || !et) return null;

  const year = msg.at.getFullYear();
  const month = msg.at.getMonth();
  const day = msg.at.getDate();

  const start = new Date(year, month, day, st.hour, st.minute);
  const end = new Date(year, month, day, et.hour, et.minute);

  // Lấy log từ trước giờ bắt đầu 30 phút đến hết ca.
  const startMinus30 = new Date(year, month, day, st.hour, st.minute - 30);
  return { startMinus30, end };
};

/** Tin tracking: nội dung bắt đầu bằng HĐT hoặc HDT (không phân biệt hoa thường). */
const isHdtTrackingMessage = (message: string): boolean => {
  const t = message.trim();
  if (!t) return false;
  const lower = t.toLocaleLowerCase("vi");
  return lower.startsWith("hđt") || lower.startsWith("hdt");
};

/** Ca + ngày (MM-DD trong YYYY-MM-DD): hiển thị full mọi tin trong khung giờ ca (bỏ lọc HĐT/HDT). */
const FULL_CHAT_BY_MONTH_DAY: { monthDay: string; sessions: number[] }[] = [
  { monthDay: "03-21", sessions: [4, 8] },
  { monthDay: "03-22", sessions: [4, 6] },
];

const isFullChatCa = (dateText: string, session: number): boolean => {
  const monthDay = dateText.slice(5);
  return FULL_CHAT_BY_MONTH_DAY.some(
    (e) => e.monthDay === monthDay && e.sessions.includes(session)
  );
};

export default function TrackingChatLog({
  chatLogText,
  fileName,
}: {
  chatLogText: string;
  fileName?: string;
}) {
  const { groups, unparsedCount, totalCount } = useMemo(() => {
    const lines = String(chatLogText ?? "").split(/\r?\n/);
    const parsed: ChatMessage[] = [];
    let unparsed = 0;

    for (const line of lines) {
      const msg = parseWebexLine(line);
      if (msg) parsed.push(msg);
      else if (line.trim()) unparsed++;
    }

    const sortedAll = [...parsed].sort((a, b) => a.at.getTime() - b.at.getTime());

    // groupKey: `${dateText}|ca-${session}`
    const groupMap = new Map<string, CaGroup>();
    const outsideCaMessages: ChatMessage[] = [];

    for (const msg of sortedAll) {
      let matchedSlot: CaSlot | null = null;

      for (const slot of CA_SCHEDULE) {
        const window = buildCaWindowForMessage(msg, slot);
        if (!window) continue;
        const { startMinus30, end } = window;

        if (msg.at.getTime() >= startMinus30.getTime() && msg.at.getTime() <= end.getTime()) {
          matchedSlot = slot;
          break;
        }
      }

      if (!matchedSlot) {
        if (isHdtTrackingMessage(msg.message)) outsideCaMessages.push(msg);
        continue;
      }

      const fullChat = isFullChatCa(msg.dateText, matchedSlot.session);
      if (!fullChat && !isHdtTrackingMessage(msg.message)) continue;

      const key = `${msg.dateText}|ca-${matchedSlot.session}`;
      if (!groupMap.has(key)) {
        const index = matchedSlot.session;
        groupMap.set(key, {
          index,
          title: `Ca ${matchedSlot.session} (${matchedSlot.startTime} - ${matchedSlot.endTime}) - ${msg.dateText}`,
          startTimeText: matchedSlot.startTime,
          endTimeText: matchedSlot.endTime,
          messages: [],
        });
      }

      groupMap.get(key)!.messages.push(msg);
    }

    const outsideKey = "__outside__";
    if (outsideCaMessages.length > 0) {
      groupMap.set(outsideKey, {
        index: 999,
        title: "Ngoai ca thi",
        startTimeText: "",
        endTimeText: "",
        messages: outsideCaMessages,
      });
    }

    const groups = Array.from(groupMap.values()).sort((a, b) => {
      // Outside group last
      if (a.index === 999) return 1;
      if (b.index === 999) return -1;

      const dateOf = (title: string) => {
        const m = title.match(/(\d{4}-\d{2}-\d{2})$/);
        return m?.[1] ?? "";
      };

      const ad = dateOf(a.title);
      const bd = dateOf(b.title);
      if (ad !== bd) return ad.localeCompare(bd);

      return a.index - b.index;
    });

    const totalCount = groups.reduce((sum, g) => sum + g.messages.length, 0);
    return { groups, unparsedCount: unparsed, totalCount };
  }, [chatLogText]);

  const [activeGroupTitle, setActiveGroupTitle] = useState<string>("");
  const [copiedMsgKey, setCopiedMsgKey] = useState<string>("");
  const [chatSearchQuery, setChatSearchQuery] = useState("");

  type SearchMatch = {
    groupTitle: string;
    groupIndex: number;
    tabLabel: string;
    message: ChatMessage;
    msgIndex: number;
  };

  const searchMatches = useMemo(() => {
    const q = chatSearchQuery.trim().toLowerCase();
    if (!q) return [] as SearchMatch[];
    const results: SearchMatch[] = [];
    for (const g of groups) {
      g.messages.forEach((m, idx) => {
        const haystack = `${m.message}\n${m.user}\n${m.rawLine}`.toLowerCase();
        if (haystack.includes(q)) {
          results.push({
            groupTitle: g.title,
            groupIndex: g.index,
            tabLabel: g.index === 999 ? g.title : `Ca ${g.index}`,
            message: m,
            msgIndex: idx,
          });
        }
      });
    }
    return results;
  }, [groups, chatSearchQuery]);
  useEffect(() => {
    if (groups.length === 0) {
      setActiveGroupTitle("");
      return;
    }
    const exists = groups.some((g) => g.title === activeGroupTitle);
    if (!exists) setActiveGroupTitle(groups[0]!.title);
  }, [groups, activeGroupTitle]);

  const activeGroup = useMemo(() => {
    if (groups.length === 0) return null;
    return groups.find((g) => g.title === activeGroupTitle) ?? groups[0] ?? null;
  }, [groups, activeGroupTitle]);

  const copyToClipboard = async (text: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fallback below
    }

    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "absolute";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(textarea);
      return ok;
    } catch {
      return false;
    }
  };

  if (!chatLogText) return null;

  return (
    <section className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 text-sm text-zinc-900">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold">Tracking chat log Webex <span className="text-red-500">(Chưa hoạt động)</span></h2>
          <p className="mt-1 text-xs text-zinc-700">
            {fileName ? (
              <>
                File: <span className="font-mono">{fileName}</span>
              </>
            ) : (
              "Chat log Webex"
            )}
          </p>
        </div>
      </div>

      <div className="mt-3">
        <p className="text-xs text-zinc-700">
          Tổng tin nhắn: <strong>{totalCount}</strong> | Số ca: <strong>{groups.length}</strong>
          {unparsedCount > 0 ? (
            <>
              {" "}
              | Dòng không nhận diện: <strong>{unparsedCount}</strong>
            </>
          ) : null}
        </p>
      </div>

      {groups.length > 0 ? (
        <div className="mt-3 space-y-2">
          <label className="block text-xs font-medium text-zinc-800" htmlFor="tracking-chat-search">
            Tìm trong chat theo ca
          </label>
          <input
            id="tracking-chat-search"
            type="search"
            value={chatSearchQuery}
            onChange={(e) => setChatSearchQuery(e.target.value)}
            placeholder="Nội dung tin, tên user, hoặc dòng log…"
            className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
            autoComplete="off"
          />
          {chatSearchQuery.trim() ? (
            <p className="text-xs text-zinc-600">
              {searchMatches.length === 0 ? (
                <>Không có tin khớp.</>
              ) : (
                <>
                  <strong>{searchMatches.length}</strong> tin khớp trên toàn bộ ca
                </>
              )}
            </p>
          ) : null}
          {searchMatches.length > 0 ? (
            <ul className="max-h-40 overflow-y-auto rounded-md border border-zinc-200 bg-zinc-50 py-1 text-xs">
              {searchMatches.map((hit, i) => {
                const key = `${hit.groupTitle}-${hit.message.at.getTime()}-${hit.msgIndex}-${i}`;
                return (
                  <li key={key} className="border-b border-zinc-100 last:border-b-0">
                    <button
                      type="button"
                      onClick={() => setActiveGroupTitle(hit.groupTitle)}
                      className="w-full px-2 py-1.5 text-left transition-colors hover:bg-zinc-100"
                    >
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="shrink-0 rounded bg-zinc-200 px-1.5 py-0.5 font-semibold text-zinc-800">
                          {hit.tabLabel}
                        </span>
                        <span className="font-mono text-[11px] text-zinc-500">
                          {hit.message.dateText} {hit.message.timeText}
                        </span>
                        <span className="font-semibold text-zinc-800">{hit.message.user}</span>
                      </div>
                      <div className="mt-0.5 line-clamp-2 break-words text-zinc-700">{hit.message.message}</div>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 max-h-[70vh] overflow-y-auto pr-1">
        {groups.length === 0 ? (
          <p className="text-xs text-zinc-700">Không có nội dung chat hợp lệ để hiển thị.</p>
        ) : (
          <>
            <div className="flex gap-2 overflow-x-auto pb-2">
              {groups.map((group) => {
                const isActive = group.title === activeGroupTitle;
                    // Tab chỉ hiển thị tên ca (vd: "Ca 1"), phần chi tiết sẽ nằm ở panel bên dưới.
                    const tabLabel = group.index === 999 ? group.title : `Ca ${group.index}`;
                return (
                  <button
                    key={`${group.index}-${group.title}`}
                    type="button"
                    onClick={() => setActiveGroupTitle(group.title)}
                    className={[
                      "shrink-0 rounded-md border px-3 py-1.5 text-xs transition-colors",
                      isActive
                        ? "border-zinc-900 bg-zinc-900 text-white"
                        : "border-zinc-200 bg-white text-zinc-800 hover:bg-zinc-50",
                    ].join(" ")}
                  >
                    <span className="font-semibold">{tabLabel}</span>
                    <span className="ml-2 text-[11px] opacity-80">({group.messages.length})</span>
                  </button>
                );
              })}
            </div>

            {activeGroup ? (
              <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                <h3 className="text-sm font-semibold text-zinc-900">{activeGroup.title}</h3>
                <p className="mt-1 text-xs text-zinc-700">{activeGroup.messages.length} tin nhắn</p>

                <div className="mt-3 space-y-2">
                  {activeGroup.messages.map((m, idx) => {
                    const msgKey = `${m.at.getTime()}-${idx}`;
                    const isCopied = copiedMsgKey === msgKey;
                    return (
                      <div
                        key={msgKey}
                        className={[
                          "rounded-md border border-zinc-200 bg-white p-2",
                          "transition-colors",
                          "hover:border-zinc-500 hover:bg-zinc-100 hover:ring-2 hover:ring-zinc-400 hover:shadow-md",
                          "active:bg-zinc-200",
                        ].join(" ")}
                      >
                        <div className="text-[11px] text-zinc-600">
                          <span className="font-mono">
                            {m.dateText} {m.timeText}
                          </span>
                          <span className="mx-2 text-zinc-300">:</span>
                          <span className="font-semibold">{m.user}</span>
                        </div>
                        <div className="mt-1 flex items-start gap-2 break-words">
                          <div className="flex-1 whitespace-pre-wrap break-words text-xs text-zinc-900">
                            {m.message}
                          </div>
                          <button
                            type="button"
                            onClick={async () => {
                              const ok = await copyToClipboard(m.message);
                              if (!ok) return;
                              setCopiedMsgKey(msgKey);
                              window.setTimeout(() => setCopiedMsgKey(""), 1200);
                            }}
                            className={[
                              "shrink-0 rounded-md border px-2 py-1 text-[11px] transition-colors",
                              "border-zinc-200 bg-white text-zinc-800 hover:bg-zinc-50",
                              isCopied ? "border-zinc-900 bg-zinc-900 text-white" : "",
                            ].join(" ")}
                          >
                            {isCopied ? "Đã copy" : "Copy"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
