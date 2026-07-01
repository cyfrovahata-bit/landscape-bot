import * as fs from "fs";
import * as path from "path";

const rootDir: string = process.cwd();

const ignore: Set<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
]);

function printTree(dir: string, prefix: string = ""): void {
  const items: string[] = fs.readdirSync(dir);

  items.forEach((item: string, index: number) => {
    if (ignore.has(item)) return;

    const fullPath: string = path.join(dir, item);
    const isLast: boolean = index === items.length - 1;
    const connector: string = isLast ? "└── " : "├── ";

    console.log(prefix + connector + item);

    if (fs.statSync(fullPath).isDirectory()) {
      const newPrefix: string = prefix + (isLast ? "    " : "│   ");
      printTree(fullPath, newPrefix);
    }
  });
}

console.log(path.basename(rootDir));
printTree(rootDir);