import { Bpmn } from "../dist/index.js";

const output = process.argv[2] ?? "exception-timeout-handling.bpmn";
const processBuilder = await Bpmn.createProcess("Process_payment", {
  name: "Payment processing"
});

const result = await processBuilder
  .startEvent("Start_payment_requested", { name: "Payment requested" })
  .serviceTask("Task_charge_card", {
    name: "Charge card",
    taskType: "charge-card",
    retries: "2",
    inputs: [{ source: "=payment", target: "payment" }]
  })
  .timerBoundaryEvent(
    "Boundary_payment_timeout",
    { duration: "PT10M", name: "Payment timeout" },
    (handler) =>
      handler
        .serviceTask("Task_notify_timeout", { taskType: "notify-payment-timeout" })
        .endEvent("End_payment_timed_out"),
    { cancelActivity: false }
  )
  .errorBoundaryEvent(
    "Boundary_payment_failed",
    { id: "Error_payment_failed", code: "PAYMENT_FAILED", name: "Payment failed" },
    (handler) =>
      handler
        .serviceTask("Task_notify_failure", { taskType: "notify-payment-failure" })
        .endEvent("End_payment_failed"),
    { name: "Payment failed" }
  )
  .endEvent("End_payment_completed", { name: "Payment completed" })
  .write({ output, layout: "none" });

console.log(JSON.stringify(result));
