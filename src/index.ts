export type StoreSnapshot = {
  name: string;
  value: unknown;
};

export function describeSnapshot(snapshot: StoreSnapshot): string {
  return `${snapshot.name} = ${JSON.stringify(snapshot.value)}`;
}
