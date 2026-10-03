package notify

import "fmt"

/* PasswordReset is the plain-text message that carries the one-time reset link.
 *
 * The link is a bearer credential — whoever opens it chooses the password and is signed
 * in — so, like the verification link, it is the whole of the message and it is not
 * copied anywhere else. The last line is for the person who did not ask: nothing changes
 * unless the link is used.
 */
func PasswordReset(product, name, link string) (subject, body string) {
	subject = "Reset your password"
	if product != "" {
		subject = "Reset your " + product + " password"
	}
	return subject, fmt.Sprintf("%s\n\nWe got a request to reset the password for your account. Choose a new one with this link. It works once and expires in 1 hour.\n\n%s\n\nIf you did not ask, you can ignore this email. Your password stays the same.\n",
		greeting(name), link)
}
