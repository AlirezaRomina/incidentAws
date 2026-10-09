/** Live elapsed time per incident, updated every second without re-rendering the workspace. */
const live = new Map<string, number>();
export const getLiveElapsed = (id: string) => live.get(id);
export const setLiveElapsed = (id: string, ms: number) => live.set(id, ms);
export const clearLiveElapsed = (id: string) => live.delete(id);
