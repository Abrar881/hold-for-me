/**
 * Deterministic IVR (Interactive Voice Response) state machine.
 *
 * Tracks the current node and an invalid-press counter.  Processes
 * one or more DTMF digits in order, stopping early at the first
 * terminal or disconnected result.
 */
import type { IvrNode } from '../data.js';

export type IvrStep =
  | { kind: 'prompt'; text: string }
  | { kind: 'terminal'; terminal: 'hold' | 'receptionist' | 'closed'; text?: string }
  | { kind: 'invalid'; text: string }
  | { kind: 'disconnected'; text: string };

export class Ivr {
  private readonly nodeMap: ReadonlyMap<string, IvrNode>;
  private currentNode: IvrNode;
  private invalidCount = 0;

  constructor(nodes: IvrNode[]) {
    this.nodeMap = new Map(nodes.map(n => [n.id, n]));
    this.currentNode = nodes[0];
  }

  /** The node the IVR is currently positioned at. */
  current(): IvrNode {
    return this.currentNode;
  }

  /**
   * Process each digit in `digits` in order.
   * Returns the result of the last step, or the first
   * terminal / disconnected result encountered.
   *
   * Rules:
   * - If the current node is terminal, any press is a no-op invalid (R3).
   * - A valid digit navigates to the next node.
   * - An invalid digit increments the counter; at 3 disconnects.
   */
  press(digits: string): IvrStep {
    let last: IvrStep = { kind: 'invalid', text: 'No digits provided.' };
    for (const digit of digits) {
      last = this._pressOne(digit);
      if (last.kind === 'terminal' || last.kind === 'disconnected') {
        return last;
      }
    }
    return last;
  }

  private _pressOne(digit: string): IvrStep {
    // R3: pressing on a terminal node is a no-op invalid.
    if (this.currentNode.terminal !== undefined) {
      return { kind: 'invalid', text: 'Cannot press on a terminal node.' };
    }

    const targetId = this.currentNode.options[digit];
    if (targetId !== undefined) {
      const target = this.nodeMap.get(targetId)!;
      this.currentNode = target;
      if (target.terminal !== undefined) {
        return { kind: 'terminal', terminal: target.terminal };
      }
      return { kind: 'prompt', text: target.prompt };
    }

    // Invalid digit.
    this.invalidCount += 1;
    if (this.invalidCount >= 3) {
      return { kind: 'disconnected', text: 'Too many invalid inputs. Disconnecting.' };
    }
    return {
      kind: 'prompt',
      text: `Sorry, that's not a valid option. ${this.currentNode.prompt}`,
    };
  }
}
