/* Lower-bound process startup baseline only; no PTY, screen or protocol.
 * Build with an already-installed compiler: cc -Os -s native-startup.c -o baseline
 */
int main(void) { return 0; }
