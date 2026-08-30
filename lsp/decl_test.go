package lsp

import "testing"

// 識別子の途中で切って「型 + 宣言子」と読まない（SSL_AD_RECORD_OVERFLO + W）。
// 引数の並びの途中にある語は宣言ではない。
func TestArgumentListsAreNotDeclarations(t *testing.T) {
	src := "int f(SSL *s) {\n\tSSLfatal(s, SSL_AD_RECORD_OVERFLOW, SSL_F_SSL3_GET_RECORD,\n\t\tSSL_R_PACKET_LENGTH_TOO_LONG);\n}\n"
	if _, _, ok := localDeclaration(src, position{Line: 1, Character: 40}, "SSL_F_SSL3_GET_RECORD"); ok {
		t.Error("SSL_F_SSL3_GET_RECORD inside a call is not a local declaration")
	}
	if !declRegexp("b").MatchString("int a, b;") || !declRegexp("p").MatchString("struct pt*p;") {
		t.Error("real declarations must still match")
	}
}
