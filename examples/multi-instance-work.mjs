import { Bpmn } from "../dist/index.js";

const output = process.argv[2] ?? "multi-instance-work.bpmn";
const processBuilder = await Bpmn.createProcess("Process_bulk_dispatch", {
  name: "Bulk dispatch"
});

const result = await processBuilder
  .startEvent("Start_dispatch_requested", { name: "Dispatch requested" })
  .serviceTask("Task_dispatch_item", {
    name: "Dispatch item",
    taskType: "dispatch-item",
    inputs: [{ source: "=item", target: "item" }]
  })
  .multiInstanceLoop({
    cardinality: "= items",
    completionCondition: "= dispatched >= required",
    sequential: false
  })
  .endEvent("End_dispatch_completed", { name: "Dispatch completed" })
  .write({ output });

console.log(JSON.stringify(result));
