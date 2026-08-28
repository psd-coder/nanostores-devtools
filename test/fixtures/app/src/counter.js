import { atom, map } from "nanostores";

export const $count = atom(0);
export const $user = map({ name: "ada" });
