// Strikes reduce output by 60% while active; they never set workers to zero.
export function strikeOutputFactor(active: boolean) {
  return active ? 0.4 : 1;
}
