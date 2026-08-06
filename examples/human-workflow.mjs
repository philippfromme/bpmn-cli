import { Bpmn } from "../dist/index.js";

const output = process.argv[2] ?? "human-workflow.bpmn";
const processBuilder = await Bpmn.createProcess("Process_leave_request", {
  name: "Leave request"
});

const publication = await processBuilder
  .startEvent("Start_leave_requested", { name: "Leave requested" })
  .userTask("Task_manager_review", {
    name: "Manager review",
    formId: "leave-request-review"
  })
  .exclusiveGateway("Gateway_leave_approved", { name: "Approved?" })
  .branch("approved", (branch) =>
    branch
      .condition("= approved")
      .serviceTask("Task_confirm_leave", {
        taskType: "confirm-leave",
        inputs: [{ source: "=request", target: "leaveRequest" }]
      })
      .endEvent("End_leave_approved", { name: "Leave approved" })
  )
  .branch("rejected", (branch) =>
    branch.defaultFlow().endEvent("End_leave_rejected", { name: "Leave rejected" })
  )
  .publish({ output });

console.log(JSON.stringify(publication));
