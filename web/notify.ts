// A desktop notification when the robot needs help, so you don't find it stranded later.
// Works while this page is open (in any tab or window). Off until you turn it on.

import { toast } from "./dom";

const KEY = "notify-problems";

export const notifySupported = (): boolean => "Notification" in window;

export function notifyEnabled(): boolean {
  try {
    return notifySupported() && Notification.permission === "granted" && localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Turn notifications on or off; asks the browser for permission the first time. Returns the result. */
export async function setNotify(on: boolean): Promise<boolean> {
  if (on && notifySupported()) {
    const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    if (permission !== "granted") {
      toast("Notifications are blocked for this page. Allow them in your browser's site settings.", true);
      on = false;
    }
  }
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // storage blocked
  }
  if (on) toast("You'll get a notification when it needs help");
  return on;
}

export function notifyProblem(title: string, body: string): void {
  if (!notifyEnabled() || document.hasFocus()) return; // in front of you: the card says it
  const n = new Notification(title, { body, tag: "robot-problem" });
  n.onclick = () => {
    window.focus();
    n.close();
  };
}
