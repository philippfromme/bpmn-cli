export default async function createCustomerEmail({ BpmnModel }) {
  const model = await BpmnModel.create();
  const process = model.process({ name: "Customer email" });
  const task = model.create("bpmn:UserTask", { name: "Send customer email" });
  model.append(process, task, "flowElements");
  task.configureForm({ formId: "customer-email" });
  task.extensions.ensure("zeebe:IoMapping").addInput({
    source: "=customer.email",
    target: "email"
  });
  return model.publish({
    output: "customer-email.bpmn",
    layout: "auto",
    validate: true
  });
}
