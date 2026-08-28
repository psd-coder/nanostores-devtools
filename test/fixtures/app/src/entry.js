import { $theme } from "@fixture/theme";

import { $count, $user } from "./counter.js";

export const state = { count: $count.get(), user: $user.get(), theme: $theme.get() };
