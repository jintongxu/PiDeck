export type SideButtonJump = {
  messageId: string;
  alignment: "top" | "center" | "bottom";
};

/** Maps standard Chromium X buttons to the hovered turn's start/end anchors. */
export function resolveSideButtonJump(
  button: number,
  startMessageId: string | undefined,
  endMessageId: string | undefined,
): SideButtonJump | null {
  // This desktop mouse reports its physical left/back thumb button as button 4.
  if (button === 4 && startMessageId) {
    return { messageId: startMessageId, alignment: "top" };
  }
  // The physical right/forward thumb button reports as button 3 on this device.
  if (button === 3 && endMessageId) {
    return { messageId: endMessageId, alignment: "bottom" };
  }
  return null;
}
