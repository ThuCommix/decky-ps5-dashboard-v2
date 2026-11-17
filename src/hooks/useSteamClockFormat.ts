import { useEffect, useState } from "react";

import { resolveClasses } from "../classes";

/** What Steam's registration handles look like across clients: a function, or an object with one of these. */
type Unregister = () => void;

/** Steam's friend settings, which is where the clock format actually lives (see `useSteamClockFormat`). */
const FRIEND_SETTINGS = "m_FriendSettings";

/** A 24-hour flag out of a settings payload, whatever the client calls it (`b24HourClock`, `bShow24HourClock`…). */
function clockFormatFrom(payload: any, depth = 2): boolean | undefined {
  if (!payload || typeof payload !== "object" || depth < 0) return undefined;
  // A key that says how the clock is *formatted* wins over one that only mentions a clock (a "show clock"
  // toggle would otherwise be read as "24-hour").
  let plain: boolean | undefined;
  for (const [key, value] of Object.entries<any>(payload)) {
    if (typeof value !== "boolean" || !/clock/i.test(key)) continue;
    if (!/24|12|hour/i.test(key)) {
      if (plain === undefined && !/show|enabl|visib/i.test(key)) plain = value;
      continue;
    }
    // A key that says 12-hour is the opposite of a 24-hour flag.
    return /12/.test(key) && !/24/.test(key) ? !value : value;
  }
  if (plain !== undefined) return plain;
  // Settings APIs wrap their payload (`{ data: … }`, `{ settings: … }`), so look one level in.
  for (const value of Object.values<any>(payload)) {
    if (value && typeof value === "object") {
      const hit = clockFormatFrom(value, depth - 1);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** Unwraps a registration handle into a plain unsubscribe function, or undefined when there's nothing to undo. */
function unregisterOf(handle: any): Unregister | undefined {
  if (typeof handle === "function") return handle;
  if (typeof handle?.Unregister === "function") return () => handle.Unregister();
  if (typeof handle?.unregister === "function") return () => handle.unregister();
  return undefined;
}

/** The class Steam's own top-bar clock carries, once the header module has been found. */
let clockSelector: string | undefined;

function clockElement(): HTMLElement | null {
  try {
    if (!clockSelector) {
      const resolved = resolveClasses();
      if (resolved.missing.includes("header")) return null;
      clockSelector = resolved.sel.header.Clock;
    }
    return document.querySelector<HTMLElement>(clockSelector);
  } catch {
    return null;
  }
}

/**
 * Reads the format off Steam's own clock text, which can't disagree with the setting: whatever it renders is
 * what Steam was told to show. A 24-hour clock prints digits and the separator and nothing else ("14:13"); a
 * 12-hour one adds a marker beside them ("2:13 PM", "2:13 nachm.", "午後2:13"), so any non-digit means 12-hour.
 */
function clockFormatFromText(text: string): boolean | undefined {
  if (!/[0-9]/.test(text)) return undefined;
  // Narrow no-break space and NBSP are part of "2:13 PM" in some ICU data, so they don't count as markers.
  return /[^\d\s:.\u202f\u00a0]/.test(text) ? false : true;
}

/**
 * The store value that holds the clock format. It is `m_FriendSettings` — Steam keeps it in its friend
 * settings, not under a clock-named key, which is why nothing in `settingsStore` matched /clock/ when the
 * plugin looked there — and `b24HourClock` sits on it directly. `clockFormatFrom` walks one level in as
 * well, so it's found whether it's the object itself or an observable's `Value`. If a client moves it, the
 * first store value carrying a clock-ish flag is used instead.
 */
function clockStoreValue(store: any): any {
  if (!store || typeof store !== "object") return undefined;
  for (const key of [FRIEND_SETTINGS, ...Object.keys(store)]) {
    const candidate = store[key];
    if (candidate && clockFormatFrom(candidate) !== undefined) return candidate;
  }
  return undefined;
}

/**
 * Is the clock 24-hour, following Steam's own setting?
 *
 * Three sources, because this setting has moved between clients and each one is a fallback for the next:
 *  1. `settingsStore.m_FriendSettings.b24HourClock` — the real one on current clients, subscribable.
 *  2. Steam's own rendered clock text, mirrored (see `clockFormatFromText`), when the bar's clock is in the
 *     DOM. Authoritative when it answers, and it survives the setting moving anywhere else.
 *  3. `SteamClient.Settings.GetAccountSettings()` and its change events, for clients that report it there.
 * All of them are re-checked every couple of seconds: the setting is changed from Steam's own UI while the
 * PS5 screens stay mounted, so nothing remounts to re-read it.
 */
export function useSteamClockFormat(): boolean {
  const [is24Hour, setIs24Hour] = useState<boolean>(true);

  useEffect(() => {
    const cleanups: Unregister[] = [];
    // Once Steam's own clock text has spoken it wins; the settings APIs are only a fallback for when the
    // bar's clock isn't in the DOM (e.g. right after boot).
    let fromClockText: boolean | undefined;
    const applyApi = (value: boolean | undefined) => {
      if (typeof value === "boolean" && fromClockText === undefined) setIs24Hour(value);
    };

    const settings: any = (window as any).SteamClient?.Settings;
    const store: any = (window as any).settingsStore;

    const storeValue = clockStoreValue(store);
    // `clockFormatFrom` looks one level in, so this covers both `m_FriendSettings.b24HourClock` and an
    // observable whose `Value` carries it.
    const readStore = () => applyApi(clockFormatFrom(storeValue));
    readStore();
    try {
      const off = unregisterOf(storeValue?.Subscribe?.(readStore));
      if (off) cleanups.push(off);
    } catch {
      /* not subscribable: the poll below covers it */
    }

    const readApis = () => {
      if (fromClockText !== undefined) return;
      for (const method of ["GetAccountSettings", "GetClientSettings"]) {
        try {
          settings?.[method]?.()?.then?.((payload: any) => applyApi(clockFormatFrom(payload)));
        } catch {
          /* not in this client */
        }
      }
    };
    readApis();

    for (const method of ["RegisterForSettingsChanges", "RegisterForClientSettingsChanges"]) {
      try {
        const off = unregisterOf(settings?.[method]?.((changed: any) => applyApi(clockFormatFrom(changed))));
        if (off) cleanups.push(off);
      } catch {
        /* not in this client */
      }
    }

    const readClockText = () => {
      const verdict = clockFormatFromText(clockElement()?.textContent ?? "");
      if (verdict === undefined || verdict === fromClockText) return;
      fromClockText = verdict;
      setIs24Hour(verdict);
    };
    readClockText();

    const refresh = () => {
      readApis();
      readStore();
      readClockText();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 2_000);

    return () => {
      for (const off of cleanups) {
        try {
          off();
        } catch {
          /* the client dropped it already */
        }
      }
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, []);

  return is24Hour;
}
