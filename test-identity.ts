import { getPreferredAccessIdentity } from "./src/auth/profile.js";
import { inferFormFieldValue } from "./src/core/formHeuristics.js";

const identity = getPreferredAccessIdentity();
console.log("Generated Identity:", identity);

const emailField = {
  label: "Email",
  placeholder: "Enter email",
  name: "email",
  id: "email",
  tag: "input",
  inputType: "email",
  required: true,
  options: []
};

const value = inferFormFieldValue(emailField, identity);
console.log("Inferred value:", value);
