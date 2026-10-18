# Ticket: timesheet summaries show absurd durations

Support reports that the weekly timesheet summary prints entries like "2026-10-01 Project Alpha 800h30m" for a normal working day, rejects night shifts that cross midnight, and shows tags inconsistently ("#Billable #billable" appears twice).

The module has three files:

- src/parser.cjs: parseEntry(line) turns one log line into an entry object.
- src/validator.cjs: validateEntry(entry) throws if the entry is not acceptable.
- src/formatter.cjs: formatEntry(line) parses, validates and renders one summary line.

The symptom shows up in the formatter, but the validator and formatter are correct and must not change. Fix the root cause in src/parser.cjs only. Edits to any other file are discarded during evaluation.

Line format: DATE START-END PROJECT [#tag ...]

- DATE is YYYY-MM-DD and is returned as-is in entry.date.
- START and END are HH:MM in 24-hour time, hours 00-23 and minutes 00-59, always two digits each. Anything else throws SyntaxError.
- entry.startMin and entry.endMin are numbers: minutes since midnight of DATE. If END is earlier than or equal to START the shift crosses midnight, so endMin is END + 1440.
- PROJECT is every word after the time range up to the first tag. Words are separated by one or more spaces or tabs; entry.project joins them with single spaces. Leading and trailing whitespace on the line is ignored.
- Tags are words starting with "#". entry.tags holds tag names without "#", lowercased, de-duplicated, in first-seen order. A lone "#" is not a tag and throws SyntaxError. Words after the first tag that do not start with "#" also throw SyntaxError.
- A line missing the date, time range or project throws SyntaxError.

parseEntry must return exactly {date, startMin, endMin, project, tags}. Keep the exports. Do not change the tests. Do not install dependencies.

Run node --test public.test.cjs. Hidden evaluation tests parseEntry directly on edge cases as well as the formatted output.
