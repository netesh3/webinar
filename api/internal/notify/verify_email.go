package notify

import "fmt"

/* VerifyEmail is the plain-text message that carries the one-time link.
 *
 * The link is a bearer credential for confirming the address, same as a join link is
 * for a webinar, so it is the whole of the message and it is not copied anywhere else.
 */
func VerifyEmail(product, name, link string) (subject, body string) {
	subject = "Verify your email"
	if product != "" {
		subject = "Verify your email for " + product
	}
	return subject, fmt.Sprintf("%s\n\nConfirm this address to finish creating your account. The link works once and expires in 24 hours.\n\n%s\n\nIf you did not create an account, you can ignore this email.\n",
		greeting(name), link)
}
