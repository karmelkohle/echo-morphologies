/** A two-column definition list that rows can be written into by key. */
export type StatusTone = 'neutral' | 'good' | 'warn' | 'alert'

export class StatusTable {
  private readonly rows = new Map<string, HTMLElement>()

  constructor(private readonly container: HTMLElement) {}

  set(key: string, value: string, tone: StatusTone = 'neutral'): void {
    let dd = this.rows.get(key)
    if (!dd) {
      const dt = document.createElement('dt')
      dt.textContent = key
      dd = document.createElement('dd')
      this.container.append(dt, dd)
      this.rows.set(key, dd)
    }
    if (dd.textContent !== value) dd.textContent = value
    if (dd.dataset.tone !== tone) dd.dataset.tone = tone
  }
}
