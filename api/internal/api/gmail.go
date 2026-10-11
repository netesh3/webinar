package api

import "strings"

/* gmailAddress is the public-register branch that sends the visitor to Google.
 *
 * Only a mailbox Google itself issues. A lookalike domain stays on the email
 * verification link, and an empty local part is not an address.
 */
func gmailAddress(email string) bool {
	email = strings.ToLower(strings.TrimSpace(email))
	at := strings.LastIndex(email, "@")
	if at <= 0 || at == len(email)-1 {
		return false
	}
	return email[at+1:] == "gmail.com"
}
