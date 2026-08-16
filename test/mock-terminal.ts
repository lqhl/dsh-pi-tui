/**
 * In-memory Terminal implementation for headless tests. pi-tui's npm build
 * does not export VirtualTerminal, and this interface is tiny.
 */
import type { Terminal } from '@earendil-works/pi-tui'

export class MockTerminal implements Terminal {
  output = ''
  width = 80
  height = 24
  /** Captured raw-input callback; tests feed key bytes through it. */
  onInput: ((data: string) => void) | undefined

  start(onInput: (data: string) => void): void {
    this.onInput = onInput
  }

  stop(): void {
    // No-op.
  }

  drainInput(): Promise<void> {
    return Promise.resolve()
  }

  write(data: string): void {
    this.output += data
  }

  get columns(): number {
    return this.width
  }

  get rows(): number {
    return this.height
  }

  get kittyProtocolActive(): boolean {
    return false
  }

  moveBy(): void {
    // No-op.
  }

  hideCursor(): void {
    // No-op.
  }

  showCursor(): void {
    // No-op.
  }

  clearLine(): void {
    // No-op.
  }

  clearFromCursor(): void {
    // No-op.
  }

  clearScreen(): void {
    // No-op.
  }

  setTitle(): void {
    // No-op.
  }

  setProgress(): void {
    // No-op.
  }
}
