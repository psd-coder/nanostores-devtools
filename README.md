# nanostores-devtools

Devtools for nanostores.

## Install

```bash
pnpm add nanostores-devtools
```

## Usage

```ts
import { describeSnapshot } from "nanostores-devtools";

describeSnapshot({ name: "$counter", value: 1 }); // "$counter = 1"
```

## License

MIT
