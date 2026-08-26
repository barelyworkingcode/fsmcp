package fsapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
)

// decodeArgs unmarshals a tool's arguments strictly: an unknown field is an
// error rather than something ignored.
//
// This is load-bearing, not tidiness. Go's default is to ignore a field it
// does not recognise and leave the intended one at its zero value — and for a
// content field that zero value is the empty string, which silently destroys
// data while the call reports success. A caller that writes "contents" instead
// of "content", or "replacement" instead of "replace", would otherwise
// truncate a file and be told it worked.
func decodeArgs(raw json.RawMessage, dst any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	// A second value on the same line is a malformed call, not a second call.
	if err := dec.Decode(new(json.RawMessage)); err != io.EOF {
		return fmt.Errorf("unexpected trailing content after the arguments object")
	}
	return nil
}

// requiredString reports the value of a field that must be present. A pointer
// distinguishes "absent" from "explicitly empty" — both are legal JSON, and
// only the second is a legitimate request to write nothing.
func requiredString(v *string, name string) (string, error) {
	if v == nil {
		return "", fmt.Errorf("%q is required; send an empty string to mean empty content", name)
	}
	return *v, nil
}
