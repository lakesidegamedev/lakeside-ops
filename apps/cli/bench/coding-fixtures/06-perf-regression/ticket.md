# Ticket: event ranking times out on large feeds

After the feed grew past 20,000 events, the ranking step in src/rank.cjs became the slowest part of the pipeline and the 2-second performance test now fails. Output is correct today on small inputs; it is just quadratic. Make it O(n log n) or better without changing a single output.

rankEvents(events) contract (unchanged):

- Each event is an object with string source, string id, number seq, number score and number ts. Other fields may be present and must be left alone.
- An event's identity is the pair (source, id). Pairs are compared exactly: source "a:b" with id "c" is a different event from source "a" with id "b:c".
- Duplicates collapse to one kept event: the one with the highest seq. If several share that highest seq, keep the one that appears first in the input.
- The result contains the kept event objects themselves (same references, not copies), ordered by score descending, then ts ascending, then the input index of the kept event ascending.
- The input array and its events must not be mutated. An empty input returns an empty array.

Constraints: change src/rank.cjs only. Keep the export. Pure JavaScript, no dependencies, no worker threads, no caching between calls. Do not change the tests.

Run node --test public.test.cjs. Hidden evaluation compares exact output and tie-breaking on many inputs, and runs the timing check on more than one data shape.
