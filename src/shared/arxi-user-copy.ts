// The product guest already declares its channel target. Keep product copy
// out of upstream installations and the separately operated Enji runtime.
export function isArxiConversation(): boolean {
  const target = process.env.ARXI_CHANNEL_TARGET;
  return target === "owner" || target === "group";
}

export function arxiUserCopy(upstream: string, product: string): string {
  return isArxiConversation() ? product : upstream;
}
