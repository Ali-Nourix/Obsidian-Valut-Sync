type Receiver = (session: string, approval: string) => Promise<void>;
const receivers = new Set<Receiver>();
/** In-memory protocol routing; never persist a connection code or session capability. */
export function watchSetupReturn(receiver: Receiver): () => void {
  receivers.add(receiver);
  return () => { receivers.delete(receiver); };
}
export function deliverSetupReturn(params: Record<string, string>): void {
  const { session, approval } = params;
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(session ?? '') || !/^[A-Za-z0-9_-]{40,64}$/.test(approval ?? '')) return;
  for (const receiver of receivers) void receiver(session, approval).catch(() => {});
}
