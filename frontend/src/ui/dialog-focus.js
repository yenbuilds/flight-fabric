// Keep keyboard navigation inside the visible controls of an open dialog.
export function containDialogFocus(event, root) {
  if (event.key !== 'Tab' || !root) return;
  const activeDialog = event.target?.closest?.('[role="dialog"][aria-modal="true"]');
  if (activeDialog && activeDialog !== root && !activeDialog.contains(root)) return;
  const focusable = Array.from(root.querySelectorAll(
    'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])',
  )).filter(element => element.tabIndex >= 0 && !element.closest('[inert]') && element.getClientRects().length > 0);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = root.ownerDocument.activeElement;
  if (!first) {
    event.preventDefault();
    root.focus({ preventScroll: true });
  } else if (!root.contains(active) || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus({ preventScroll: true });
  }
}
