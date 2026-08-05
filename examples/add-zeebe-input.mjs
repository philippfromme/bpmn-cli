export default async function addZeebeInput({ BpmnModel }) {
  const model = await BpmnModel.open("customer-support.bpmn");
  model.element("ServiceTask_1").extensions.ensure("zeebe:IoMapping").addInput({
    source: "=customer.id",
    target: "customerId"
  });
  return model.publish({
    output: "customer-support.edited.bpmn",
    layout: "auto",
    validate: true
  });
}
