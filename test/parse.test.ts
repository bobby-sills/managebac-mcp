import assert from "node:assert/strict";
import { parseTaskTiles, parseClasses, parseTimetable, htmlToText, mainContent } from "../src/parse.ts";
import { upcomingHtml, pastHtml, classesHtml, timetableHtml } from "./fixtures.ts";

const base = "https://yourschool.managebac.com";

const up = parseTaskTiles(upcomingHtml, base);
assert.equal(up.tasks.length, 2);
assert.deepEqual(up.tabCounts, { upcoming: "0", past: "0", overdue: "2" });
const t0 = up.tasks[0];
assert.equal(t0.title, "Summative C - Lab Report");
assert.equal(t0.task_id, 5000001);
assert.equal(t0.class_id, 1000002);
assert.equal(t0.due, "Nov 13, 11:55 AM");
assert.equal(t0.class_name, "IB MYP Science (Grade 10)");
assert.equal(t0.group, "Today - Friday, Nov 13");
assert.deepEqual(t0.labels, ["Summative", "Pending"]);
assert.equal(t0.result, undefined, "Submit button text should not become a result");
assert.equal(up.tasks[1].title, "SUM - Crit A & B - Draft");
assert.deepEqual(up.tasks[1].labels, ["Summative", "Performance Cycle", "Pending"]);

const past = parseTaskTiles(pastHtml, base);
assert.equal(past.tasks.length, 2);
const p0 = past.tasks[0];
assert.equal(p0.result, "Complete");
assert.deepEqual(p0.labels, ["Formative", "Homework", "Submitted (5 minutes early)"]);
assert.match(p0.comment!, /^Good start on this draft\./);
assert.match(p0.comment!, /\n- Upload your planning notes\./);
assert.ok(!/Comment/.test(p0.comment!.slice(0, 10)));
const p1 = past.tasks[1];
assert.deepEqual(p1.criteria_scores, [
  { criterion: "C", name: "C: Communicating", score: "8/8" },
  { criterion: "D", name: "D: Applying mathematics in real-life contexts", score: "8/8" },
]);
assert.deepEqual(p1.labels, ["Summative", "Submitted (11 hours late)"]);

const classes = parseClasses(classesHtml, base);
assert.deepEqual(classes.map((c) => [c.class_id, c.name]), [
  [1000001, "IB MYP Mathematics: extended (Grade 10)"],
  [1000002, "IB MYP Science (Grade 10)"],
]);

const tt = parseTimetable(timetableHtml);
assert.equal(tt.days.length, 2);
assert.equal(tt.days[0].day, "Nov 9, Mon Rotation Day 6");
assert.deepEqual(tt.days[0].periods[0], { period: "Homeroom / Attendance", details: "Homeroom / Attendance · P · Present" });
assert.equal(tt.days[0].periods[1].details, "8:45 AM - 10:05 AM · Mathematics: extended · Grade 10 · A. Teacher · Room 101");
assert.equal(tt.days[1].periods[1].details, "Break");
assert.deepEqual(tt.related_start_dates, ["2026-11-06"]);

assert.equal(htmlToText("<p>Hi <b>there</b></p><ul><li>a</li><li>b</li></ul><script>x</script>"), "Hi there\n\n- a\n- b");
const mc = mainContent(`<title>ManageBac | Task Details</title><main><div class="f-layout-main__content"><h3>Task Details</h3><p>Write an essay.</p><a href="/privacy_attachments/abc">brief.pdf</a><a href="https://docs.google.com/x">Rubric</a></div></main>`, base);
assert.equal(mc.title, "Task Details");
assert.match(mc.text, /# Task Details\n+Write an essay\./);
assert.deepEqual(mc.files, [{ name: "brief.pdf", url: base + "/privacy_attachments/abc" }]);
assert.deepEqual(mc.external_links, [{ text: "Rubric", url: "https://docs.google.com/x" }]);

console.log("All parser tests passed");
