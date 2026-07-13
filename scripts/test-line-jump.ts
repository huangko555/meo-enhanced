import { isAcceptedLineJumpInput, parseLineJumpTarget } from '../webview/src/helpers/lineJump';

const acceptedInputs = ['', '1', '10', '9999'];
for (const value of acceptedInputs) {
  if (!isAcceptedLineJumpInput(value)) {
    throw new Error(`Expected line input to be accepted: ${JSON.stringify(value)}`);
  }
}

const rejectedInputs = ['0', '01', '-1', '1.5', '1a', ' 1'];
for (const value of rejectedInputs) {
  if (isAcceptedLineJumpInput(value)) {
    throw new Error(`Expected line input to be rejected: ${JSON.stringify(value)}`);
  }
}

if (parseLineJumpTarget('1', 20) !== 1 || parseLineJumpTarget('20', 20) !== 20) {
  throw new Error('Valid line target was rejected');
}
if (parseLineJumpTarget('21', 20) !== null || parseLineJumpTarget('0', 20) !== null) {
  throw new Error('Out-of-range line target was accepted');
}

console.log('line jump checks passed');
