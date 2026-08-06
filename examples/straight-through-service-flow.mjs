import { Bpmn } from "../dist/index.js";

const output = process.argv[2] ?? "straight-through-service-flow.bpmn";
const processBuilder = await Bpmn.createProcess("Process_order_fulfilment", {
  name: "Order fulfilment"
});

const publication = await processBuilder
  .startEvent("Start_order_received", { name: "Order received" })
  .serviceTask("Task_validate_order", {
    name: "Validate order",
    taskType: "validate-order",
    retries: "3",
    inputs: [{ source: "=order", target: "order" }],
    outputs: [{ source: "=validatedOrder", target: "validatedOrder" }],
    headers: { priority: "high" }
  })
  .serviceTask("Task_fulfil_order", {
    name: "Fulfil order",
    taskType: "fulfil-order",
    inputs: [{ source: "=validatedOrder", target: "order" }]
  })
  .endEvent("End_order_fulfilled", { name: "Order fulfilled" })
  .publish({ output });

console.log(JSON.stringify(publication));
