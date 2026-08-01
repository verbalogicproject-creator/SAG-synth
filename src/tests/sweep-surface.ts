/**
 * src/tests/sweep-surface.ts — walk the whole instrument the way a thumb would.
 *
 * Not a test file (no `.test.` in the name, so no project collects it). It is the shared
 * walk behind `synth-tabs.browser.test.ts` — which proves every declared address is
 * REACHABLE — and `dead-controls.browser.test.ts` — which proves everything reachable is
 * LIVE. Two claims, one traversal, and a second copy of the traversal would be one more
 * thing to drift.
 *
 * **The nesting is three deep and that matters.** A flat "click every `role=tab` in order"
 * loop looks right and silently misses a level: the LFO slot tabs live inside the FILTER
 * tab's LFO sub-tab, so resetting to the top tab between clicks makes them disappear before
 * they are ever pressed. That bug hid fifteen addresses.
 *
 * So the walk selects by `aria-label`, which names the level explicitly:
 *
 *   [aria-label="signal path"]        the four tabs
 *   [aria-label$="sections"]          this tab's groups (FILTER | LFO | EQ)
 *   [aria-label$="slot"]              this group's slot family (A/B/C, 1..4)
 *
 * Those labels are part of the accessible contract that a screen reader depends on, so a
 * rename is a deliberate act that should break this. An index into a flat list is not.
 */

export type Recorder = () => void;

const tabsIn = (container: HTMLElement, selector: string): HTMLElement[] => {
  const bar = container.querySelector(selector);
  return bar === null ? [] : [...bar.querySelectorAll('[role="tab"]')].map((n) => n as HTMLElement);
};

/**
 * Click through every tab, group and slot, calling `record` at each resting state.
 *
 * @param click must flush React — pass an `act`-wrapping helper.
 */
export async function sweepSurface(
  container: HTMLElement,
  click: (element: Element) => Promise<void>,
  record: Recorder,
): Promise<void> {
  const topTabs = () => tabsIn(container, '[role="tablist"][aria-label="signal path"]');
  const groupTabs = () => tabsIn(container, '[role="tablist"][aria-label$="sections"]');
  const slotTabs = () => tabsIn(container, '[role="tablist"][aria-label$="slot"]');

  const topCount = topTabs().length;
  if (topCount === 0) throw new Error('sweepSurface: no top-level tabs were rendered');

  for (let top = 0; top < topCount; top += 1) {
    await click(topTabs()[top]!);
    record();

    // Re-counted rather than cached: how many groups a tab has is a property of the tab.
    const groupCount = groupTabs().length;

    // `max(groupCount, 1)` so a tab with no sub-bar still runs its slot pass once.
    for (let group = 0; group < Math.max(groupCount, 1); group += 1) {
      if (groupCount > 0) {
        await click(topTabs()[top]!);
        await click(groupTabs()[group]!);
        record();
      }

      // Slot letters do not change which slots exist, so no reset is needed between them.
      const slots = slotTabs();
      for (let slot = 0; slot < slots.length; slot += 1) {
        await click(slotTabs()[slot]!);
        record();
      }
    }
  }
}
