use std::net::IpAddr;

pub fn is_private_addr(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_private_v4(v4),
        IpAddr::V6(v6) => {
            // IPv4-mapped IPv6 (::ffff:0:0/96): re-check on the IPv4 form so
            // attackers can't bypass the v4 list by using the mapped representation.
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_private_v4(mapped);
            }
            v6.is_loopback() || v6.is_unspecified()
                || v6.is_unique_local() || v6.is_unicast_link_local()
        }
    }
}

fn is_private_v4(v4: std::net::Ipv4Addr) -> bool {
    let o = v4.octets();
    if o == [0, 0, 0, 0] { return true; }
    if o[0] == 10 { return true; }                                  // 10.0.0.0/8
    if o[0] == 127 { return true; }                                 // 127.0.0.0/8
    if o[0] == 169 && o[1] == 254 { return true; }                  // 169.254.0.0/16
    if o[0] == 172 && (o[1] & 0xF0) == 0x10 { return true; }        // 172.16.0.0/12
    if o[0] == 192 && o[1] == 168 { return true; }                  // 192.168.0.0/16
    if o[0] == 100 && (o[1] & 0xC0) == 0x40 { return true; }        // 100.64.0.0/10 CGNAT
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn blocks_localhost() {
        assert!(is_private_addr(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
        assert!(is_private_addr(IpAddr::V6(Ipv6Addr::LOCALHOST)));
    }

    #[test]
    fn blocks_aws_metadata() {
        assert!(is_private_addr(IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254))));
    }

    #[test]
    fn blocks_rfc1918() {
        assert!(is_private_addr(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))));
        assert!(is_private_addr(IpAddr::V4(Ipv4Addr::new(172, 16, 0, 1))));
        assert!(is_private_addr(IpAddr::V4(Ipv4Addr::new(172, 31, 255, 255))));
        assert!(is_private_addr(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))));
    }

    #[test]
    fn allows_public() {
        assert!(!is_private_addr(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
        assert!(!is_private_addr(IpAddr::V4(Ipv4Addr::new(140, 82, 114, 4)))); // github
    }

    #[test]
    fn blocks_ipv4_mapped_ipv6() {
        // ::ffff:127.0.0.1 is loopback in disguise; must be blocked.
        let mapped: Ipv6Addr = "::ffff:127.0.0.1".parse().unwrap();
        assert!(is_private_addr(IpAddr::V6(mapped)));
        let mapped_aws: Ipv6Addr = "::ffff:169.254.169.254".parse().unwrap();
        assert!(is_private_addr(IpAddr::V6(mapped_aws)));
    }

    #[test]
    fn decimal_ip_form_resolves_through_url_parse() {
        // url::Url parses http://2130706433/ as 127.0.0.1; once it's an IpAddr
        // the SSRF check catches it. This guards against attackers smuggling
        // private addresses past naive string-based block-lists.
        let u = url::Url::parse("http://2130706433/").unwrap();
        match u.host() {
            Some(url::Host::Ipv4(v4)) => assert!(is_private_addr(IpAddr::V4(v4))),
            other => panic!("expected Ipv4 host, got {:?}", other),
        }
    }
}
