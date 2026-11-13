import { RuntimeUpgradeRetryError } from "../../domain/runtime/errors.js";
/** One event-loop gate covers admission through durable completion and drain entry. */
export class RuntimeAdmissionGate {
  private active = 0;
  private draining = false;
  get state(): "ready" | "draining" { return this.draining ? "draining" : "ready"; }
  get pendingCount(): number { return this.active; }
  enter(): () => void {
    if (this.draining) throw new RuntimeUpgradeRetryError();
    this.active++;
    let released = false;
    return () => { if (!released) { released = true; this.active--; } };
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    const release = this.enter();
    try { return await work(); } finally { release(); }
  }
  async background(work: () => Promise<void>): Promise<void> {
    if (this.draining) return;
    await this.run(work);
  }
  async drain(timeoutMs = 5000): Promise<void> {
    if (this.draining) throw new Error("Another control drain is already in progress.");
    this.draining = true;
    const deadline = Date.now() + timeoutMs;
    while (this.active) {
      if (Date.now() >= deadline) { this.draining = false; throw new Error("Control drain timed out; old control retained and admission reopened. Admitted work continues."); }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  reopen(): void { this.draining = false; }
}
