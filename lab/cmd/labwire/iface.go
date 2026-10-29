package main

import "net"

// netInterfaceByName devolve o índice da interface pelo nome.
func netInterfaceByName(name string) (int, error) {
	ifc, err := net.InterfaceByName(name)
	if err != nil {
		return 0, err
	}
	return ifc.Index, nil
}
