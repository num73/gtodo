/** Save all editor windows before taking a backup or merging another folder. */
export async function withSavedWorkspace<T>(action: () => Promise<T>, options: {
  flushMain: () => Promise<boolean>;
  flushNotes: () => Promise<boolean>;
  resume: () => void;
  failureMessage: string;
}): Promise<T> {
  try {
    const results = await Promise.allSettled([
      Promise.resolve().then(options.flushMain),
      Promise.resolve().then(options.flushNotes),
    ]);
    if (results.some(result => result.status === 'rejected' || !result.value)) throw new Error(options.failureMessage);
    return await action();
  } finally { options.resume(); }
}
