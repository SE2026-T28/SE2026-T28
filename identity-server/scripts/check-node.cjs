const required = "24.22.0";

if (process.versions.node !== required) {
  console.error(`APP-04 requires Node.js ${required}; current version is ${process.versions.node}.`);
  console.error("Run: source ~/.nvm/nvm.sh && nvm use");
  process.exit(1);
}
