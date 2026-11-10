import { version } from "../package.json";
const build = Number(process.env.GITHUB_RUN_NUMBER);
if (!Number.isSafeInteger(build) || build < 1) throw Error("GITHUB_RUN_NUMBER must be a positive integer");
console.log(`${version.split(".").slice(0, 2).join(".")}.${build}`);
