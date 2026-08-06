import { Bpmn } from "../dist/index.js";

const output = process.argv[2] ?? "collaboration.bpmn";
const collaboration = await Bpmn.createCollaboration("Collaboration_order", {
  name: "Order collaboration"
});

const publication = await collaboration
  .process("Process_buyer", { name: "Buyer process" })
  .process("Process_seller", { name: "Seller process" })
  .participant("Participant_buyer", {
    name: "Buyer",
    processId: "Process_buyer"
  })
  .participant("Participant_seller", {
    name: "Seller",
    processId: "Process_seller"
  })
  .message("Message_order_request", { name: "Order request" })
  .messageFlow("MessageFlow_order_request", {
    name: "Send order request",
    sourceId: "Participant_buyer",
    targetId: "Participant_seller",
    messageId: "Message_order_request"
  })
  .publish({ output, layout: "none" });

console.log(JSON.stringify(publication));
